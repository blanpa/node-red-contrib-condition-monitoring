const helper = require("node-red-node-test-helper");
const trainingDataCollectorNode = require("../nodes/training-data-collector.js");
const fs = require("fs");
const path = require("path");
const os = require("os");

helper.init(require.resolve("node-red"));

describe("training-data-collector Node", function () {
    // Temp directory for test data
    let testDataDir;

    beforeEach(function (done) {
        testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-test-"));
        // The node writes below RED.settings.userDir. Point it at the temp dir:
        // helper.load()'s third argument is credentials, not settings, so
        // without this every export landed in <repo>/training-data/.
        helper.settings({ userDir: testDataDir });
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(function () {
                // Cleanup test directory
                try {
                    if (fs.existsSync(testDataDir)) {
                        fs.rmSync(testDataDir, { recursive: true, force: true });
                    }
                } catch {
                    // Ignore cleanup errors
                }
                done();
            });
        });
    });

    // Helper to create node with settings
    function createFlow(nodeConfig) {
        return [
            {
                id: "n1",
                type: "training-data-collector",
                name: "test-collector",
                datasetName: "test_dataset",
                outputPath: "",
                mode: "batch",
                autoSave: false,
                featureSource: "payload",
                featureFields: "",
                includeTimestamp: true,
                timestampFormat: "iso",
                labelMode: "manual",
                labelField: "label",
                defaultLabel: "normal",
                bufferSize: 100,
                windowSize: 10,
                windowOverlap: 50,
                flushOnDeploy: false,
                exportFormat: "csv",
                compressionEnabled: false,
                compressionThreshold: 10000,
                shuffleOnExport: false,
                includeMetadata: true,
                s3Enabled: false,
                validateData: true,
                wires: [["n2"]],
                ...nodeConfig
            },
            { id: "n2", type: "helper" }
        ];
    }

    it("should be loaded", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            try {
                expect(n1.name).toBe("test-collector");
                expect(n1.datasetName).toBe("test_dataset");
                expect(n1.mode).toBe("batch");
                done();
            } catch (err) {
                done(err);
            }
        });
    });

    it("should collect numeric payload", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            // Send numeric data
            n1.receive({ payload: 42.5 });
            n1.receive({ payload: 43.2 });
            n1.receive({ payload: 41.8 });

            // Check buffer
            setTimeout(function () {
                try {
                    expect(n1.dataBuffer.map((s) => s.features)).toEqual([
                        { value: 42.5 },
                        { value: 43.2 },
                        { value: 41.8 }
                    ]);
                    expect(n1.dataBuffer.map((s) => s.label)).toEqual(["normal", "normal", "normal"]);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should collect object payload with features", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            // Send object data
            n1.receive({
                payload: {
                    temperature: 65.5,
                    vibration_rms: 0.742,
                    pressure: 2.1
                }
            });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(1);
                    n1.dataBuffer[0].features.should.have.property("temperature", 65.5);
                    n1.dataBuffer[0].features.should.have.property("vibration_rms", 0.742);
                    n1.dataBuffer[0].features.should.have.property("pressure", 2.1);
                    n1.featureNames.should.containDeep(["temperature", "vibration_rms", "pressure"]);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should collect array payload", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: [0.5, 0.6, 0.7, 0.8] });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(1);
                    n1.dataBuffer[0].values.should.deepEqual([0.5, 0.6, 0.7, 0.8]);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should use default label", function (done) {
        const flow = createFlow({ defaultLabel: "healthy" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 42 });

            setTimeout(function () {
                try {
                    n1.dataBuffer[0].label.should.equal("healthy");
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should extract label from message", function (done) {
        const flow = createFlow({ labelMode: "fromMessage", labelField: "label" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 42, label: "bearing_fault" });

            setTimeout(function () {
                try {
                    n1.dataBuffer[0].label.should.equal("bearing_fault");
                    n1.labelClasses.has("bearing_fault").should.be.true();
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should extract severity from message", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 42, label: "fault", severity: 0.7 });

            setTimeout(function () {
                try {
                    n1.dataBuffer[0].severity.should.equal(0.7);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should track label classes", function (done) {
        const flow = createFlow({ labelMode: "fromMessage" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 1, label: "normal" });
            n1.receive({ payload: 2, label: "bearing" });
            n1.receive({ payload: 3, label: "unbalance" });
            n1.receive({ payload: 4, label: "normal" });

            setTimeout(function () {
                try {
                    n1.labelClasses.size.should.equal(3);
                    n1.labelClasses.has("normal").should.be.true();
                    n1.labelClasses.has("bearing").should.be.true();
                    n1.labelClasses.has("unbalance").should.be.true();
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should calculate statistics", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: { value: 10 } });
            n1.receive({ payload: { value: 20 } });
            n1.receive({ payload: { value: 30 } });

            setTimeout(function () {
                try {
                    Object.keys(n1.statistics).should.eql(["value"]);
                    n1.statistics.value.sumSquares.should.equal(1400);
                    n1.statistics.value.count.should.equal(3);
                    n1.statistics.value.min.should.equal(10);
                    n1.statistics.value.max.should.equal(30);
                    n1.statistics.value.sum.should.equal(60);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should respond to stats action", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            // Add some data first
            n1.receive({ payload: { temp: 65 }, label: "normal" });
            n1.receive({ payload: { temp: 70 }, label: "fault" });

            n2.on("input", function (msg) {
                try {
                    msg.should.have.property("topic", "stats");
                    msg.payload.should.have.property("samples", 2);
                    msg.payload.features.should.eql(["temp"]);
                    msg.payload.labelDistribution.should.eql({ normal: 1, fault: 1 });
                    msg.payload.classes.should.eql(["normal", "fault"]);
                    msg.payload.totalCollected.should.equal(2);
                    msg.payload.statistics.temp.mean.should.equal(67.5);
                    msg.payload.bufferUsage.should.equal("2.0%");
                    done();
                } catch (err) {
                    done(err);
                }
            });

            setTimeout(function () {
                n1.receive({ action: "stats" });
            }, 100);
        });
    });

    it("should respond to clear action", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n1.receive({ payload: 42 });
            n1.receive({ payload: 43 });

            n2.on("input", function (msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    msg.payload.should.have.property("action", "clear");
                    n1.dataBuffer.length.should.equal(0);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            setTimeout(function () {
                n1.receive({ action: "clear" });
            }, 100);
        });
    });

    it("should respond to pause/resume actions", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 1 });
            n1.receive({ action: "pause" });
            n1.receive({ payload: 2 }); // Should be ignored
            n1.receive({ payload: 3 }); // Should be ignored
            n1.receive({ action: "resume" });
            n1.receive({ payload: 4 });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(2); // Only 1 and 4
                    done();
                } catch (err) {
                    done(err);
                }
            }, 200);
        });
    });

    it("should export to CSV", function (done) {
        const flow = createFlow({ exportFormat: "csv" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n1.receive({ payload: { temp: 65, vib: 0.5 }, label: "normal" });
            n1.receive({ payload: { temp: 70, vib: 0.8 }, label: "fault" });

            n2.on("input", function (msg) {
                try {
                    msg.should.have.property("topic", "export");
                    msg.payload.should.have.property("success", true);
                    msg.payload.should.have.property("samples", 2);
                    // 2 samples at the default 80/10/10 split, unshuffled:
                    // 1 → train, 0 → val, 1 → test; plus the metadata file.
                    msg.payload.splits.should.eql({ train: 1, val: 0, test: 1 });
                    msg.payload.files
                        .map((f) => path.basename(f).replace(/^.*_(?=train|test|metadata)/, ""))
                        .should.eql(["train.csv", "test.csv", "metadata.json"]);
                    msg.payload.files
                        .every((f) => path.dirname(f) === path.join(testDataDir, "training-data"))
                        .should.be.true();

                    // The files must contain the samples, not just exist.
                    const rows = (f) => fs.readFileSync(f, "utf8").trim().split("\n");
                    const train = rows(msg.payload.files[0]);
                    const test = rows(msg.payload.files[1]);
                    train[0].should.equal("timestamp,temp,vib,label,severity");
                    train.length.should.equal(2);
                    train[1].split(",").slice(1).should.eql(["65", "0.5", "normal", "0"]);
                    test[1].split(",").slice(1).should.eql(["70", "0.8", "fault", "0"]);

                    done();
                } catch (err) {
                    done(err);
                }
            });

            setTimeout(function () {
                n1.receive({ action: "export" });
            }, 100);
        });
    });

    it("should export to JSONL", function (done) {
        const flow = createFlow({ exportFormat: "jsonl" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n1.receive({ payload: [0.5, 0.6], label: "normal" });
            n1.receive({ payload: [0.7, 0.8], label: "fault" });

            n2.on("input", function (msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    // Default 80/10/10 split of 2 unshuffled samples → one
                    // line in the train file, one in the test file.
                    const records = msg.payload.files
                        .filter((f) => f.endsWith(".jsonl"))
                        .map((f) => fs.readFileSync(f, "utf8").trim().split("\n"))
                        .map((lines) => lines.map((l) => JSON.parse(l)));
                    records.map((r) => r.length).should.eql([1, 1]);
                    const strip = (r) => ({ features: r.features, label: r.label });
                    strip(records[0][0]).should.eql({ features: [0.5, 0.6], label: "normal" });
                    strip(records[1][0]).should.eql({ features: [0.7, 0.8], label: "fault" });
                    Number.isNaN(Date.parse(records[0][0].timestamp)).should.be.false();

                    done();
                } catch (err) {
                    done(err);
                }
            });

            setTimeout(function () {
                n1.receive({ action: "export" });
            }, 100);
        });
    });

    it("should export to JSON with metadata", function (done) {
        const flow = createFlow({ exportFormat: "json", includeMetadata: true });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n1.receive({ payload: { temp: 65 }, label: "normal" });

            n2.on("input", function (msg) {
                try {
                    msg.payload.should.have.property("success", true);

                    const jsonFile = msg.payload.files.find((f) => f.endsWith(".json") && !f.includes("metadata"));

                    const content = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
                    content.data.should.eql([{ x: [65], y: "normal" }]);
                    content.datasetInfo.name.should.equal("test_dataset");
                    content.datasetInfo.samples.should.equal(1);
                    content.datasetInfo.features.should.eql(["temp"]);
                    content.datasetInfo.classes.should.eql(["normal"]);
                    content.datasetInfo.featureDimension.should.equal(1);
                    content.datasetInfo.statistics.should.eql({
                        temp: { count: 1, mean: 65, std: 0, min: 65, max: 65 }
                    });

                    // Check metadata file content
                    const metaFile = msg.payload.files.find((f) => f.includes("metadata"));
                    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
                    meta.datasetInfo.exportedSamples.should.equal(1);
                    meta.features.names.should.eql(["temp"]);
                    meta.labels.should.eql({ mode: "manual", classes: ["normal"], distribution: { normal: 1 } });
                    meta.config.exportFormat.should.equal("json");

                    done();
                } catch (err) {
                    done(err);
                }
            });

            setTimeout(function () {
                n1.receive({ action: "export" });
            }, 100);
        });
    });

    it("should validate data and reject NaN", function (done) {
        const flow = createFlow({ validateData: true });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 42 });
            n1.receive({ payload: NaN }); // Should be rejected
            n1.receive({ payload: 43 });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(2); // Only valid values
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should use custom feature fields", function (done) {
        const flow = createFlow({
            featureSource: "custom",
            featureFields: "sensor.temp,sensor.pressure"
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({
                payload: { other: 999 },
                sensor: { temp: 65, pressure: 2.1, humidity: 40 }
            });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(1);
                    n1.dataBuffer[0].features.should.have.property("sensor.temp", 65);
                    n1.dataBuffer[0].features.should.have.property("sensor.pressure", 2.1);
                    // humidity should not be included
                    n1.featureNames.should.not.containEql("sensor.humidity");
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should handle RUL countdown mode", function (done) {
        const flow = createFlow({
            labelMode: "rul",
            rulStartValue: 10,
            rulUnit: "samples"
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            n1.receive({ payload: 1 });
            n1.receive({ payload: 2 });
            n1.receive({ payload: 3 });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(3);
                    // RUL decrements after recording, so first is start-1
                    n1.dataBuffer[0].label.should.equal(9);
                    n1.dataBuffer[1].label.should.equal(8);
                    n1.dataBuffer[2].label.should.equal(7);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });

    it("should reset RUL on action", function (done) {
        const flow = createFlow({
            labelMode: "rul",
            rulStartValue: 100,
            rulUnit: "samples"
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n1.receive({ payload: 1 });
            n1.receive({ payload: 2 });

            n2.on("input", function (msg) {
                if (msg.topic === "control" && msg.payload.action === "resetRul") {
                    try {
                        msg.payload.rul.should.equal(50);
                        n1.currentRul.should.equal(50);
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });

            setTimeout(function () {
                n1.receive({ action: "resetRul", rulValue: 50 });
            }, 100);
        });
    });

    it("should handle timeseries mode with windows", function (done) {
        const flow = createFlow({
            mode: "timeseries",
            windowSize: 5,
            windowOverlap: 0
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            // Send 10 samples (should create windows)
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: [i, i * 2], label: i < 5 ? "normal" : "fault" });
            }

            setTimeout(function () {
                try {
                    // Should have created at least 1 window
                    n1.dataBuffer.length.should.be.greaterThanOrEqual(1);
                    n1.dataBuffer[0].features.length.should.equal(5); // Window of 5
                    done();
                } catch (err) {
                    done(err);
                }
            }, 200);
        });
    });

    it("should split data into train/val/test", function (done) {
        const flow = createFlow({
            exportFormat: "csv",
            shuffleOnExport: false // Disable shuffle for predictable test
        });

        // Set split ratio via node property
        flow[0].splitRatio = { train: 0.6, val: 0.2, test: 0.2 };

        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            // Add 10 samples
            for (let i = 0; i < 10; i++) {
                n1.receive({ payload: { value: i }, label: "class" + (i % 2) });
            }

            n2.on("input", function (msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    msg.payload.splits.should.eql({ train: 6, val: 2, test: 2 });

                    // 3 CSV files + metadata, and (unshuffled) the samples
                    // land in the splits in arrival order.
                    msg.payload.files.length.should.equal(4);
                    const values = (suffix) =>
                        fs
                            .readFileSync(
                                msg.payload.files.find((f) => f.endsWith(suffix)),
                                "utf8"
                            )
                            .trim()
                            .split("\n")
                            .slice(1)
                            .map((row) => Number(row.split(",")[1]));
                    values("_train.csv").should.eql([0, 1, 2, 3, 4, 5]);
                    values("_val.csv").should.eql([6, 7]);
                    values("_test.csv").should.eql([8, 9]);

                    done();
                } catch (err) {
                    done(err);
                }
            });

            setTimeout(function () {
                n1.receive({ action: "export" });
            }, 100);
        });
    });

    it("should report label distribution", function (done) {
        const flow = createFlow({ labelMode: "fromMessage" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            // Unbalanced data
            for (let i = 0; i < 10; i++) n1.receive({ payload: i, label: "normal" });
            for (let i = 0; i < 2; i++) n1.receive({ payload: i, label: "fault" });

            n2.on("input", function (msg) {
                if (msg.topic === "export") {
                    try {
                        msg.payload.labelDistribution.should.have.property("normal", 10);
                        msg.payload.labelDistribution.should.have.property("fault", 2);
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });

            setTimeout(function () {
                n1.receive({ action: "export" });
            }, 100);
        });
    });

    it("should handle empty export gracefully", function (done) {
        const flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                try {
                    msg.payload.should.have.property("success", false);
                    msg.payload.error.should.equal("No data to export");
                    msg.payload.samples.should.equal(0);
                    done();
                } catch (err) {
                    done(err);
                }
            });

            n1.receive({ action: "export" });
        });
    });

    it("should handle isAnomaly from anomaly-detector", function (done) {
        const flow = createFlow({ labelMode: "fromMessage" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function () {
            const n1 = helper.getNode("n1");

            // Simulate output from anomaly-detector
            n1.receive({ payload: 42, isAnomaly: false });
            n1.receive({ payload: 99, isAnomaly: true });

            setTimeout(function () {
                try {
                    n1.dataBuffer.length.should.equal(2);
                    n1.dataBuffer[0].label.should.equal("normal"); // Default when no anomaly
                    n1.dataBuffer[1].label.should.equal("anomaly");
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
});
