#!/usr/bin/env python3
"""
MAX Engine Bridge Server for Node-RED ML Inference
===================================================

This is a lightweight HTTP server that provides ONNX model inference
using MAX Engine (or ONNX Runtime as fallback).

Endpoints:
- GET  /health         - Health check
- GET  /status         - Server status and loaded models
- POST /load           - Load a model
- POST /predict        - Run inference
- POST /unload         - Unload a model

The server automatically detects if MAX Engine is available and falls back
to ONNX Runtime for CPU inference if not.

Usage:
    python max_bridge.py

Environment Variables:
    MAX_BRIDGE_PORT: Server port (default: 8765)
    MAX_BRIDGE_HOST: Server host (default: 0.0.0.0)
"""

import os
import sys
import json
import time
import traceback
from typing import Dict, Any, Optional, List
import numpy as np

# Try to import MAX Engine, fallback to ONNX Runtime
MAX_AVAILABLE = False
ONNX_AVAILABLE = False

try:
    from max import engine as max_engine
    MAX_AVAILABLE = True
    print("[MAX Bridge] MAX Engine available - using high-performance inference")
except ImportError:
    print("[MAX Bridge] MAX Engine not available, trying ONNX Runtime...")

try:
    import onnxruntime as ort
    ONNX_AVAILABLE = True
    if not MAX_AVAILABLE:
        print("[MAX Bridge] Using ONNX Runtime as inference backend")
except ImportError:
    if not MAX_AVAILABLE:
        print("[MAX Bridge] ERROR: Neither MAX Engine nor ONNX Runtime available!")
        sys.exit(1)

# Flask for HTTP server
try:
    from flask import Flask, request, jsonify
except ImportError:
    print("[MAX Bridge] ERROR: Flask not installed. Run: pip install flask")
    sys.exit(1)


app = Flask(__name__)

# Model storage
_models: Dict[str, Any] = {}
_model_info: Dict[str, Dict] = {}
_inference_session: Optional[Any] = None  # MAX Engine session (shared)

# Statistics
_stats = {
    "requests_total": 0,
    "inference_total": 0,
    "errors_total": 0,
    "avg_inference_time_ms": 0,
    "start_time": time.time()
}


def get_inference_session():
    """Get or create MAX Engine inference session."""
    global _inference_session
    
    if MAX_AVAILABLE and _inference_session is None:
        try:
            # MAX Engine requires device specification
            # Try GPU first, fallback to CPU
            try:
                _inference_session = max_engine.InferenceSession(devices=["gpu:0"])
                print("[MAX Bridge] MAX Engine InferenceSession created (GPU)")
            except Exception:
                try:
                    _inference_session = max_engine.InferenceSession(devices=["cpu"])
                    print("[MAX Bridge] MAX Engine InferenceSession created (CPU)")
                except Exception as cpu_err:
                    print(f"[MAX Bridge] MAX session creation failed: {cpu_err}")
                    _inference_session = None
        except Exception as e:
            print(f"[MAX Bridge] Failed to create MAX session: {e}")
            _inference_session = None
    
    return _inference_session


def load_model_max(model_path: str, model_id: str) -> Dict:
    """Load model using MAX Engine."""
    session = get_inference_session()
    if session is None:
        raise RuntimeError("MAX Engine session not available")
    
    model = session.load(model_path)
    _models[model_id] = {
        "model": model,
        "backend": "max",
        "path": model_path
    }
    
    # Get input/output info
    input_names = []
    output_names = []
    
    # MAX Engine model info extraction
    try:
        # Attempt to get metadata (API may vary by version)
        if hasattr(model, 'input_metadata'):
            input_names = list(model.input_metadata.keys())
        if hasattr(model, 'output_metadata'):
            output_names = list(model.output_metadata.keys())
    except:
        pass
    
    return {
        "model_id": model_id,
        "backend": "max",
        "input_names": input_names,
        "output_names": output_names
    }


def load_model_onnx(model_path: str, model_id: str) -> Dict:
    """Load model using ONNX Runtime."""
    # Session options for optimization
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.intra_op_num_threads = os.cpu_count() or 4
    
    # Try GPU first, fallback to CPU
    providers = ['CPUExecutionProvider']
    try:
        if 'CUDAExecutionProvider' in ort.get_available_providers():
            providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
    except:
        pass
    
    session = ort.InferenceSession(model_path, sess_options, providers=providers)
    
    _models[model_id] = {
        "model": session,
        "backend": "onnx",
        "path": model_path
    }
    
    input_names = [inp.name for inp in session.get_inputs()]
    output_names = [out.name for out in session.get_outputs()]
    input_shapes = [inp.shape for inp in session.get_inputs()]
    
    return {
        "model_id": model_id,
        "backend": "onnx",
        "input_names": input_names,
        "output_names": output_names,
        "input_shapes": input_shapes,
        "providers": session.get_providers()
    }


def predict_max(model_id: str, input_data: Any) -> Any:
    """Run inference using MAX Engine."""
    model_info = _models.get(model_id)
    if not model_info:
        raise ValueError(f"Model {model_id} not loaded")
    
    model = model_info["model"]
    
    # Prepare input
    if isinstance(input_data, list):
        input_array = np.array(input_data, dtype=np.float32)
    else:
        input_array = input_data
    
    # Ensure batch dimension
    if len(input_array.shape) == 1:
        input_array = input_array.reshape(1, -1)
    
    # Execute inference
    # MAX Engine uses keyword arguments for inputs
    outputs = model.execute(input=input_array)
    
    # Convert output to list
    if isinstance(outputs, dict):
        result = {k: v.tolist() if hasattr(v, 'tolist') else v for k, v in outputs.items()}
    elif hasattr(outputs, 'tolist'):
        result = outputs.tolist()
    else:
        result = outputs
    
    return result


def predict_onnx(model_id: str, input_data: Any) -> Any:
    """Run inference using ONNX Runtime."""
    model_info = _models.get(model_id)
    if not model_info:
        raise ValueError(f"Model {model_id} not loaded")
    
    session = model_info["model"]
    
    # Prepare input
    if isinstance(input_data, list):
        input_array = np.array(input_data, dtype=np.float32)
    else:
        input_array = input_data
    
    # Ensure batch dimension
    if len(input_array.shape) == 1:
        input_array = input_array.reshape(1, -1)
    
    # Get input name
    input_name = session.get_inputs()[0].name
    
    # Run inference
    outputs = session.run(None, {input_name: input_array})
    
    # Convert to list
    if len(outputs) == 1:
        return outputs[0].tolist()
    else:
        return [out.tolist() for out in outputs]


# ============================================
# HTTP Endpoints
# ============================================

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "healthy",
        "backend": "max" if MAX_AVAILABLE else "onnx",
        "models_loaded": len(_models)
    })


@app.route('/status', methods=['GET'])
def status():
    """Get server status and loaded models."""
    _stats["requests_total"] += 1
    
    uptime = time.time() - _stats["start_time"]
    
    return jsonify({
        "status": "running",
        "backend": "max" if MAX_AVAILABLE else "onnx",
        "max_available": MAX_AVAILABLE,
        "onnx_available": ONNX_AVAILABLE,
        "models": list(_models.keys()),
        "model_info": {k: {"backend": v["backend"], "path": v["path"]} for k, v in _models.items()},
        "stats": {
            "requests_total": _stats["requests_total"],
            "inference_total": _stats["inference_total"],
            "errors_total": _stats["errors_total"],
            "avg_inference_time_ms": round(_stats["avg_inference_time_ms"], 2),
            "uptime_seconds": round(uptime, 1)
        }
    })


@app.route('/load', methods=['POST'])
def load_model():
    """Load a model for inference."""
    _stats["requests_total"] += 1
    
    try:
        data = request.get_json()
        model_path = data.get('model_path')
        model_id = data.get('model_id') or os.path.basename(model_path)
        prefer_backend = data.get('backend', 'auto')  # auto, max, onnx
        
        if not model_path:
            return jsonify({"success": False, "error": "model_path required"}), 400
        
        # Check if already loaded
        if model_id in _models:
            return jsonify({
                "success": True,
                "message": f"Model {model_id} already loaded",
                "model_id": model_id,
                "backend": _models[model_id]["backend"]
            })
        
        # Check file exists
        if not os.path.exists(model_path):
            return jsonify({"success": False, "error": f"Model file not found: {model_path}"}), 404
        
        # Load model
        start_time = time.time()
        
        if prefer_backend == 'max' or (prefer_backend == 'auto' and MAX_AVAILABLE):
            try:
                result = load_model_max(model_path, model_id)
            except Exception as e:
                if ONNX_AVAILABLE and prefer_backend == 'auto':
                    print(f"[MAX Bridge] MAX load failed, falling back to ONNX: {e}")
                    result = load_model_onnx(model_path, model_id)
                else:
                    raise
        else:
            result = load_model_onnx(model_path, model_id)
        
        load_time = (time.time() - start_time) * 1000
        
        return jsonify({
            "success": True,
            "message": f"Model {model_id} loaded successfully",
            "load_time_ms": round(load_time, 2),
            **result
        })
    
    except Exception as e:
        _stats["errors_total"] += 1
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/predict', methods=['POST'])
def predict():
    """Run inference on a loaded model."""
    _stats["requests_total"] += 1
    _stats["inference_total"] += 1
    
    try:
        data = request.get_json()
        model_id = data.get('model_id')
        input_data = data.get('input_data')
        
        if not model_id:
            return jsonify({"success": False, "error": "model_id required"}), 400
        
        if input_data is None:
            return jsonify({"success": False, "error": "input_data required"}), 400
        
        if model_id not in _models:
            return jsonify({"success": False, "error": f"Model {model_id} not loaded"}), 404
        
        # Run inference
        start_time = time.time()
        
        backend = _models[model_id]["backend"]
        if backend == "max":
            result = predict_max(model_id, input_data)
        else:
            result = predict_onnx(model_id, input_data)
        
        inference_time = (time.time() - start_time) * 1000
        
        # Update average inference time
        n = _stats["inference_total"]
        _stats["avg_inference_time_ms"] = (
            (_stats["avg_inference_time_ms"] * (n - 1) + inference_time) / n
        )
        
        return jsonify({
            "success": True,
            "prediction": result,
            "inference_time_ms": round(inference_time, 2),
            "backend": backend
        })
    
    except Exception as e:
        _stats["errors_total"] += 1
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/unload', methods=['POST'])
def unload_model():
    """Unload a model from memory."""
    _stats["requests_total"] += 1
    
    try:
        data = request.get_json()
        model_id = data.get('model_id')
        
        if not model_id:
            return jsonify({"success": False, "error": "model_id required"}), 400
        
        if model_id not in _models:
            return jsonify({"success": False, "error": f"Model {model_id} not loaded"}), 404
        
        del _models[model_id]
        
        return jsonify({
            "success": True,
            "message": f"Model {model_id} unloaded"
        })
    
    except Exception as e:
        _stats["errors_total"] += 1
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/batch_predict', methods=['POST'])
def batch_predict():
    """Run batch inference on multiple inputs."""
    _stats["requests_total"] += 1
    
    try:
        data = request.get_json()
        model_id = data.get('model_id')
        inputs = data.get('inputs')  # List of input arrays
        
        if not model_id or not inputs:
            return jsonify({"success": False, "error": "model_id and inputs required"}), 400
        
        if model_id not in _models:
            return jsonify({"success": False, "error": f"Model {model_id} not loaded"}), 404
        
        # Stack inputs into batch
        batch_input = np.array(inputs, dtype=np.float32)
        
        start_time = time.time()
        
        backend = _models[model_id]["backend"]
        if backend == "max":
            result = predict_max(model_id, batch_input)
        else:
            result = predict_onnx(model_id, batch_input)
        
        inference_time = (time.time() - start_time) * 1000
        
        _stats["inference_total"] += len(inputs)
        
        return jsonify({
            "success": True,
            "predictions": result,
            "batch_size": len(inputs),
            "inference_time_ms": round(inference_time, 2),
            "per_sample_ms": round(inference_time / len(inputs), 2),
            "backend": backend
        })
    
    except Exception as e:
        _stats["errors_total"] += 1
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


def main():
    """Start the MAX Bridge server."""
    host = os.environ.get('MAX_BRIDGE_HOST', '0.0.0.0')
    port = int(os.environ.get('MAX_BRIDGE_PORT', 8765))
    
    print("=" * 60)
    print("MAX Engine Bridge Server for Node-RED")
    print("=" * 60)
    print(f"Backend: {'MAX Engine' if MAX_AVAILABLE else 'ONNX Runtime'}")
    print(f"Listening on: http://{host}:{port}")
    print(f"Health check: http://{host}:{port}/health")
    print("=" * 60)
    
    # Initialize MAX session if available
    if MAX_AVAILABLE:
        get_inference_session()
    
    # Use gunicorn in production, Flask dev server otherwise
    try:
        from gunicorn.app.base import BaseApplication
        
        class StandaloneApplication(BaseApplication):
            def __init__(self, app, options=None):
                self.options = options or {}
                self.application = app
                super().__init__()
            
            def load_config(self):
                for key, value in self.options.items():
                    if key in self.cfg.settings and value is not None:
                        self.cfg.set(key.lower(), value)
            
            def load(self):
                return self.application
        
        options = {
            'bind': f'{host}:{port}',
            'workers': 1,  # Single worker for model state consistency
            'threads': 4,
            'timeout': 120,
            'keepalive': 5
        }
        
        StandaloneApplication(app, options).run()
    
    except ImportError:
        # Fallback to Flask dev server
        print("[MAX Bridge] Gunicorn not available, using Flask dev server")
        app.run(host=host, port=port, threaded=True)


if __name__ == '__main__':
    main()
