#!/usr/bin/env python3
"""
Google Coral Edge TPU Inference Helper Script
Called from Node.js to run inference on Coral hardware
"""
import sys
import json
import numpy as np

try:
    from pycoral.utils import edgetpu
    from pycoral.adapters import common
    CORAL_AVAILABLE = True
except ImportError:
    CORAL_AVAILABLE = False
    print(json.dumps({"error": "PyCoral not installed. Install with: pip3 install pycoral"}))
    sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python3 coral_inference.py <model_path> <input_json>"}))
        sys.exit(1)
    
    model_path = sys.argv[1]
    input_json = sys.argv[2]
    
    try:
        # Parse input data
        input_data = json.loads(input_json)
        
        # Check if Coral device is available
        devices = edgetpu.list_edge_tpus()
        if not devices:
            print(json.dumps({
                "error": "No Coral Edge TPU device found",
                "available_devices": []
            }))
            sys.exit(1)
        
        # Load model
        interpreter = edgetpu.make_interpreter(model_path)
        interpreter.allocate_tensors()
        
        # Get input/output details
        input_details = interpreter.get_input_details()[0]
        output_details = interpreter.get_output_details()[0]
        
        # Prepare input
        input_array = np.array(input_data, dtype=input_details['dtype'])
        
        # Reshape if needed
        expected_shape = input_details['shape']
        if input_array.shape != tuple(expected_shape):
            input_array = input_array.reshape(expected_shape)
        
        # Quantize if needed (for INT8 models)
        if input_details['dtype'] == np.int8:
            # Input should already be quantized, but we can handle float32 input
            if input_array.dtype == np.float32:
                scale, zero_point = input_details['quantization']
                input_array = np.round(input_array / scale + zero_point).astype(np.int8)
        
        # Run inference
        interpreter.set_tensor(input_details['index'], input_array)
        interpreter.invoke()
        
        # Get output
        output_data = interpreter.get_tensor(output_details['index'])
        
        # Dequantize if needed
        if output_details['dtype'] == np.int8:
            scale, zero_point = output_details['quantization']
            output_data = (output_data.astype(np.float32) - zero_point) * scale
        
        # Convert to list for JSON
        result = output_data.tolist()
        
        # Return result
        print(json.dumps({
            "output": result,
            "shape": list(output_data.shape),
            "dtype": str(output_data.dtype),
            "device": devices[0] if devices else None
        }))
        
    except FileNotFoundError:
        print(json.dumps({"error": f"Model file not found: {model_path}"}))
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {str(e)}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "type": type(e).__name__
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()

