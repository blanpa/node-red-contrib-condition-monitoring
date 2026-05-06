#!/usr/bin/env node
/**
 * Generate minimal test models for ml-inference integration tests.
 *
 * Creates:
 *   - test/fixtures/tfjs_model/model.json  (TensorFlow.js LayersModel, 10 -> 1)
 *   - test/fixtures/model.onnx             (ONNX linear model, 10 -> 1)
 *
 * Run once:  node test/fixtures/generate-models.js
 */

const path = require("path");
const fs = require("fs");

const FIXTURES_DIR = __dirname;

async function generateTFJSModel() {
    let tf;
    try {
        tf = require("@tensorflow/tfjs-node");
    } catch {
        console.log("Skipping TFJS model: @tensorflow/tfjs-node not installed");
        return;
    }

    const model = tf.sequential();
    model.add(tf.layers.dense({ inputShape: [10], units: 1 }));
    model.compile({ optimizer: "sgd", loss: "meanSquaredError" });

    const savePath = "file://" + path.join(FIXTURES_DIR, "tfjs_model");
    await model.save(savePath);
    console.log("Created TFJS model at test/fixtures/tfjs_model/");
}

async function generateONNXModel() {
    // Build a minimal valid ONNX protobuf by hand.
    // The model computes: output = MatMul(input, weights) + bias
    // input shape: [1, 10], output shape: [1, 1]

    const ort = (() => {
        try {
            return require("onnxruntime-node");
        } catch {
            return null;
        }
    })();

    if (!ort) {
        console.log("Skipping ONNX model: onnxruntime-node not installed");
        return;
    }

    // --- tiny ONNX file built from raw bytes (no protobuf dep needed) ---
    // We construct a valid onnx ModelProto manually using the ONNX protobuf
    // wire format.  The graph:
    //   input  "input"   float [1,10]
    //   output "output"  float [1,1]
    //   initializer weights float [10,1] (all 0.1)
    //   initializer bias   float [1]    (0.0)
    //   nodes: MatMul(input, weights) -> mm_out
    //          Add(mm_out, bias)      -> output

    function encodeVarint(value) {
        const bytes = [];
        while (value > 0x7f) {
            bytes.push((value & 0x7f) | 0x80);
            value >>>= 7;
        }
        bytes.push(value & 0x7f);
        return Buffer.from(bytes);
    }

    function field(fieldNumber, wireType, data) {
        const tag = encodeVarint((fieldNumber << 3) | wireType);
        if (wireType === 2) {
            // length-delimited
            const len = encodeVarint(data.length);
            return Buffer.concat([tag, len, data]);
        } else if (wireType === 0) {
            // varint
            return Buffer.concat([tag, encodeVarint(data)]);
        } else if (wireType === 5) {
            // 32-bit
            const buf = Buffer.alloc(4);
            buf.writeFloatLE(data);
            return Buffer.concat([tag, buf]);
        }
        return Buffer.concat([tag, data]);
    }

    function str(s) {
        return Buffer.from(s, "utf-8");
    }

    // TensorProto for float tensor
    function makeTensor(name, dims, floatValues) {
        const parts = [];
        // data_type = 1 (FLOAT)
        parts.push(field(2, 0, 1));
        // dims
        for (const d of dims) {
            parts.push(field(1, 0, d));
        }
        // float_data (field 4, repeated float – packed)
        const floatBuf = Buffer.alloc(floatValues.length * 4);
        floatValues.forEach((v, i) => floatBuf.writeFloatLE(v, i * 4));
        parts.push(field(4, 2, floatBuf));
        // name
        if (name) parts.push(field(8, 2, str(name)));
        return Buffer.concat(parts);
    }

    // TypeProto.Tensor
    function makeTensorType(elemType, shape) {
        const shapeParts = [];
        for (const dim of shape) {
            // TensorShapeProto.Dimension: dim_value = field 1
            shapeParts.push(field(1, 2, field(1, 0, dim)));
        }
        const shapeProto = Buffer.concat(shapeParts);
        // TensorTypeProto: elem_type=1, shape=2
        return Buffer.concat([field(1, 0, elemType), field(2, 2, shapeProto)]);
    }

    // TypeProto: tensor_type = field 1
    function makeTypeProto(elemType, shape) {
        return field(1, 2, makeTensorType(elemType, shape));
    }

    // ValueInfoProto: name=1, type=2
    function makeValueInfo(name, elemType, shape) {
        return Buffer.concat([field(1, 2, str(name)), field(2, 2, makeTypeProto(elemType, shape))]);
    }

    // NodeProto: input=1, output=2, name=3, op_type=4
    function makeNode(inputs, outputs, name, opType) {
        const parts = [];
        for (const inp of inputs) parts.push(field(1, 2, str(inp)));
        for (const out of outputs) parts.push(field(2, 2, str(out)));
        parts.push(field(3, 2, str(name)));
        parts.push(field(4, 2, str(opType)));
        return Buffer.concat(parts);
    }

    // Weights: [10,1] all 0.1
    const weights = makeTensor("weights", [10, 1], new Array(10).fill(0.1));
    // Bias: [1] = 0.0
    const bias = makeTensor("bias", [1], [0.0]);

    // Nodes
    const matmulNode = makeNode(["input", "weights"], ["mm_out"], "matmul", "MatMul");
    const addNode = makeNode(["mm_out", "bias"], ["output"], "add", "Add");

    // Graph inputs/outputs
    const inputInfo = makeValueInfo("input", 1, [1, 10]);
    const outputInfo = makeValueInfo("output", 1, [1, 1]);

    // GraphProto: node=1, name=2, input=11, output=12, initializer=5
    const graphParts = [
        field(1, 2, matmulNode),
        field(1, 2, addNode),
        field(2, 2, str("test_graph")),
        field(11, 2, inputInfo),
        field(12, 2, outputInfo),
        field(5, 2, weights),
        field(5, 2, bias)
    ];
    const graph = Buffer.concat(graphParts);

    // OperatorSetIdProto: version = field 2
    const opsetImport = field(2, 0, 13);

    // ModelProto: ir_version=1, opset_import=8, graph=7
    const model = Buffer.concat([field(1, 0, 7), field(8, 2, opsetImport), field(7, 2, graph)]);

    const onnxPath = path.join(FIXTURES_DIR, "model.onnx");
    fs.writeFileSync(onnxPath, model);

    // Verify the model loads correctly
    try {
        const session = await ort.InferenceSession.create(onnxPath);
        const inputTensor = new ort.Tensor("float32", Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [1, 10]);
        const results = await session.run({ input: inputTensor });
        const output = results.output.data;
        console.log(`Created ONNX model at test/fixtures/model.onnx (test output: ${output[0].toFixed(4)})`);
    } catch (err) {
        console.error("ONNX model verification failed:", err.message);
        fs.unlinkSync(onnxPath);
        throw err;
    }
}

(async () => {
    await generateTFJSModel();
    await generateONNXModel();
    console.log("Done.");
})();
