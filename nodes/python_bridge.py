#!/usr/bin/env python3
"""
Persistent Python Bridge for ML Inference
==========================================

This script runs as a long-lived subprocess and communicates via stdin/stdout JSON.
It avoids the overhead of spawning a new Python process for each inference request.

Protocol:
- Input: JSON object per line with {"id": "...", "command": "...", ...}
- Output: JSON object per line with {"id": "...", "success": true/false, "result": ...}

Commands:
- load_model: Load a model from file
- predict: Run inference on loaded model
- unload_model: Unload a model from memory
- status: Get current status and loaded models
- shutdown: Gracefully shutdown the bridge
"""

import sys
import json
import os
import traceback
import signal

# Suppress TensorFlow warnings
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

# Model cache
_models = {}
_model_types = {}

def send_response(msg_id, success, result=None, error=None):
    """Send JSON response to stdout."""
    response = {
        "id": msg_id,
        "success": success
    }
    if result is not None:
        response["result"] = result
    if error is not None:
        response["error"] = error
    
    # Write to stdout with flush
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def load_keras_model(model_path):
    """Load a Keras model (.keras, .h5)."""
    try:
        from tensorflow import keras
    except ImportError:
        import keras
    
    return keras.models.load_model(model_path), "keras"


def load_sklearn_model(model_path):
    """Load a scikit-learn model (.pkl, .joblib)."""
    ext = os.path.splitext(model_path)[1].lower()
    
    if ext == '.joblib':
        import joblib
        return joblib.load(model_path), "sklearn"
    else:
        import pickle
        with open(model_path, 'rb') as f:
            return pickle.load(f), "sklearn"


def load_tflite_model(model_path):
    """Load a TFLite model (.tflite)."""
    try:
        import tflite_runtime.interpreter as tflite
    except ImportError:
        import tensorflow.lite as tflite
    
    interpreter = tflite.Interpreter(model_path=model_path)
    interpreter.allocate_tensors()
    return interpreter, "tflite"


def handle_load_model(msg_id, model_path, model_id=None):
    """Load a model and cache it."""
    if not model_id:
        model_id = os.path.basename(model_path)
    
    if model_id in _models:
        send_response(msg_id, True, {"message": f"Model {model_id} already loaded"})
        return
    
    ext = os.path.splitext(model_path)[1].lower()
    
    try:
        if ext in ['.keras', '.h5']:
            model, model_type = load_keras_model(model_path)
        elif ext in ['.pkl', '.joblib']:
            model, model_type = load_sklearn_model(model_path)
        elif ext == '.tflite':
            model, model_type = load_tflite_model(model_path)
        else:
            send_response(msg_id, False, error=f"Unsupported model format: {ext}")
            return
        
        _models[model_id] = model
        _model_types[model_id] = model_type
        
        send_response(msg_id, True, {
            "message": f"Model {model_id} loaded successfully",
            "model_id": model_id,
            "model_type": model_type
        })
    
    except Exception as e:
        send_response(msg_id, False, error=str(e))


def handle_predict(msg_id, model_id, input_data):
    """Run inference on a loaded model."""
    import numpy as np
    
    if model_id not in _models:
        send_response(msg_id, False, error=f"Model {model_id} not loaded")
        return
    
    model = _models[model_id]
    model_type = _model_types[model_id]
    
    try:
        # Convert input to numpy array
        input_array = np.array(input_data, dtype=np.float32)
        
        # Ensure 2D shape (batch, features)
        if len(input_array.shape) == 1:
            input_array = input_array.reshape(1, -1)
        
        if model_type == "keras":
            prediction = model.predict(input_array, verbose=0)
            result = prediction.tolist()
        
        elif model_type == "sklearn":
            # Check if model has predict_proba (classifiers)
            if hasattr(model, 'predict_proba'):
                prediction = model.predict_proba(input_array)
            else:
                prediction = model.predict(input_array)
                if len(prediction.shape) == 1:
                    prediction = prediction.reshape(-1, 1)
            result = prediction.tolist()
        
        elif model_type == "tflite":
            input_details = model.get_input_details()
            output_details = model.get_output_details()
            
            # Set input tensor
            model.set_tensor(input_details[0]['index'], input_array)
            
            # Run inference
            model.invoke()
            
            # Get output
            prediction = model.get_tensor(output_details[0]['index'])
            result = prediction.tolist()
        
        else:
            send_response(msg_id, False, error=f"Unknown model type: {model_type}")
            return
        
        send_response(msg_id, True, result)
    
    except Exception as e:
        send_response(msg_id, False, error=str(e))


def handle_unload_model(msg_id, model_id):
    """Unload a model from memory."""
    if model_id in _models:
        del _models[model_id]
        del _model_types[model_id]
        send_response(msg_id, True, {"message": f"Model {model_id} unloaded"})
    else:
        send_response(msg_id, False, error=f"Model {model_id} not loaded")


def handle_status(msg_id):
    """Return current status and loaded models."""
    packages = []
    
    try:
        import sklearn
        packages.append("sklearn")
    except ImportError:
        pass
    
    try:
        import tensorflow
        packages.append("tensorflow")
    except ImportError:
        pass
    
    try:
        import tflite_runtime
        packages.append("tflite")
    except ImportError:
        pass
    
    try:
        import numpy
        packages.append("numpy")
    except ImportError:
        pass
    
    send_response(msg_id, True, {
        "loaded_models": list(_models.keys()),
        "model_types": dict(_model_types),
        "packages": packages,
        "python_version": sys.version.split()[0]
    })


def main():
    """Main loop - read JSON commands from stdin, respond on stdout."""
    
    # Handle SIGTERM gracefully
    def handle_sigterm(signum, frame):
        send_response("shutdown", True, {"message": "Bridge shutting down"})
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)
    
    # Send ready signal
    send_response("ready", True, {"message": "Python bridge ready"})
    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            send_response("error", False, error=f"Invalid JSON: {e}")
            continue
        
        msg_id = msg.get("id", "unknown")
        command = msg.get("command", "")
        
        try:
            if command == "load_model":
                handle_load_model(msg_id, msg.get("model_path"), msg.get("model_id"))
            
            elif command == "predict":
                handle_predict(msg_id, msg.get("model_id"), msg.get("input_data"))
            
            elif command == "unload_model":
                handle_unload_model(msg_id, msg.get("model_id"))
            
            elif command == "status":
                handle_status(msg_id)
            
            elif command == "shutdown":
                send_response(msg_id, True, {"message": "Shutting down"})
                break
            
            elif command == "ping":
                send_response(msg_id, True, {"message": "pong"})
            
            else:
                send_response(msg_id, False, error=f"Unknown command: {command}")
        
        except Exception as e:
            send_response(msg_id, False, error=f"Error: {str(e)}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
