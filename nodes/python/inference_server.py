#!/usr/bin/env python3
"""
Remote Inference Server for Node-RED ML Inference
=================================================

A lightweight HTTP inference server that runs as a *separate container* and
serves the same model operations as the local stdin/stdout bridge
(python_bridge.py): TensorFlow Lite, Keras and scikit-learn.

It is the network sibling of python_bridge.py. The Node.js side
(nodes/remote-python-bridge.js) talks to it when CM_INFERENCE_URL is set, so
ml-inference's keras/sklearn/tflite paths run in this container instead of a
subprocess inside Node-RED.

Endpoints (JSON in / JSON out):
- GET  /health   -> {"status": "healthy", ...}
- GET  /status   -> loaded models, packages, stats
- POST /load     -> {"model_path": "...", "model_id": "..."}
- POST /predict  -> {"model_id": "...", "input_data": [...]}
- POST /unload   -> {"model_id": "..."}

Concurrency model:
- The server is multi-threaded (ThreadingHTTPServer) so independent requests run
  in parallel — a slow predict on one model does not block predicts on another.
- A short `_cache_lock` guards the model registry (load/unload/lookup).
- Each model gets its own `_model_locks[id]`, held only for the actual inference
  call. Predicts on *different* models run concurrently; predicts on the *same*
  model are serialized — required because a TFLite Interpreter (set_tensor /
  invoke / get_tensor) is not thread-safe, and Keras predict is not guaranteed
  to be either. The slow model load itself runs outside `_cache_lock`, so it
  never blocks inference on already-loaded models.
- For load distribution across *machines*, run several replicas and let the
  client shard by model_id (see docs/REMOTE-INFERENCE.md). This server stays
  single-replica-stateful by design; horizontal scaling lives in the client/LB.

The model *loaders* are imported from python_bridge.py so the two backends
cannot drift apart. Only the (short) numpy predict path is mirrored here.

Environment variables:
    CM_INFERENCE_HOST: bind host (default: 0.0.0.0)
    CM_INFERENCE_PORT: bind port (default: 8770)
"""

import os
import sys
import json
import time
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Reuse the exact model loaders from the stdin/stdout bridge so both backends
# behave identically. These return (model, model_type) and do not touch stdout.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from python_bridge import (  # noqa: E402
    load_keras_model,
    load_sklearn_model,
    load_tflite_model,
)

# Model registry. Guarded by _cache_lock for structural changes; per-model
# inference is serialized via _model_locks[model_id].
_models = {}
_model_types = {}
_model_locks = {}
_last_used = {}  # model_id -> monotonic-ish timestamp, for LRU eviction
_cache_lock = threading.Lock()

# Optional LRU cap on resident models. 0 = unlimited (keeps every loaded model,
# the right default for the named-worker / sharded deployment). Set a positive
# value for the load-on-demand / replicas:N deployment, where any replica may
# end up loading any model and memory must be bounded.
MAX_MODELS = int(os.environ.get("CM_INFERENCE_MAX_MODELS", "0") or "0")

_stats = {
    "requests_total": 0,
    "inference_total": 0,
    "errors_total": 0,
    "avg_inference_time_ms": 0.0,
    "start_time": time.time(),
}
_stats_lock = threading.Lock()


def _bump(key, n=1):
    """Thread-safe increment of a counter in _stats."""
    with _stats_lock:
        _stats[key] += n


def _record_inference(inference_ms):
    """Thread-safe update of the rolling inference-time average."""
    with _stats_lock:
        _stats["inference_total"] += 1
        n = _stats["inference_total"]
        _stats["avg_inference_time_ms"] = (
            _stats["avg_inference_time_ms"] * (n - 1) + inference_ms
        ) / n


def _evict_lru_locked(protect_id):
    """Evict least-recently-used models until at most MAX_MODELS remain.

    Caller must hold _cache_lock. `protect_id` (the model just loaded/used) is
    never evicted. A model whose inference lock is currently held still gets its
    registry entry removed — the in-flight predict keeps its own references and
    finishes cleanly; only future predicts would have to reload it.
    """
    if MAX_MODELS <= 0:
        return
    while len(_models) > MAX_MODELS:
        candidates = [m for m in _last_used if m != protect_id]
        if not candidates:
            break
        victim = min(candidates, key=lambda m: _last_used.get(m, 0))
        _models.pop(victim, None)
        _model_types.pop(victim, None)
        _model_locks.pop(victim, None)
        _last_used.pop(victim, None)


def _detect_packages():
    """Report which optional ML runtimes are importable (for /status)."""
    packages = []
    for name in ("numpy", "sklearn", "tensorflow", "tflite_runtime", "joblib"):
        try:
            __import__(name)
            packages.append("tflite" if name == "tflite_runtime" else name)
        except ImportError:
            pass
    return packages


def do_load(model_path, model_id):
    """Load and cache a model. Returns a result dict; raises on failure.

    The (potentially slow) load runs outside _cache_lock so it cannot stall
    inference on other models; the registry is updated under the lock once the
    model is ready.
    """
    if not model_path:
        raise ValueError("model_path required")
    if not model_id:
        model_id = os.path.basename(model_path)

    with _cache_lock:
        if model_id in _models:
            return {"message": f"Model {model_id} already loaded",
                    "model_id": model_id, "model_type": _model_types[model_id]}

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found: {model_path}")

    ext = os.path.splitext(model_path)[1].lower()
    if ext in (".keras", ".h5"):
        model, model_type = load_keras_model(model_path)
    elif ext in (".pkl", ".joblib"):
        model, model_type = load_sklearn_model(model_path)
    elif ext == ".tflite":
        model, model_type = load_tflite_model(model_path)
    else:
        raise ValueError(f"Unsupported model format: {ext}")

    with _cache_lock:
        # Another thread may have loaded the same id while we were busy; if so,
        # keep the existing entry and drop ours (last-writer-wins is harmless,
        # but avoiding the swap keeps any in-flight predict's lock valid).
        if model_id not in _models:
            _models[model_id] = model
            _model_types[model_id] = model_type
            _model_locks[model_id] = threading.Lock()
        model_type = _model_types[model_id]
        _last_used[model_id] = time.time()
        _evict_lru_locked(model_id)

    return {"message": f"Model {model_id} loaded successfully",
            "model_id": model_id, "model_type": model_type}


def do_predict(model_id, input_data, model_path=None):
    """Run inference on a cached model. Mirrors python_bridge.handle_predict.

    If the model is not resident and `model_path` is supplied, it is loaded on
    demand. This is what lets `replicas: N` behind one service name work: a
    request may land on a replica that never received the explicit /load, and it
    self-heals by loading from the (shared) model path. It also makes the
    sharded deployment resilient to a replica restart wiping its cache.
    """
    import numpy as np

    with _cache_lock:
        present = model_id in _models
    if not present and model_path:
        do_load(model_path, model_id)

    with _cache_lock:
        if model_id not in _models:
            raise ValueError(f"Model {model_id} not loaded")
        model = _models[model_id]
        model_type = _model_types[model_id]
        lock = _model_locks[model_id]
        _last_used[model_id] = time.time()

    input_array = np.array(input_data, dtype=np.float32)
    if len(input_array.shape) == 1:
        input_array = input_array.reshape(1, -1)

    # Serialize inference per model: TFLite/Keras predict paths are not
    # thread-safe. Different models hold different locks -> run concurrently.
    with lock:
        if model_type == "keras":
            return model.predict(input_array, verbose=0).tolist()

        if model_type == "sklearn":
            if hasattr(model, "predict_proba"):
                prediction = model.predict_proba(input_array)
            else:
                prediction = model.predict(input_array)
                if len(prediction.shape) == 1:
                    prediction = prediction.reshape(-1, 1)
            return prediction.tolist()

        if model_type == "tflite":
            input_details = model.get_input_details()
            output_details = model.get_output_details()
            model.set_tensor(input_details[0]["index"], input_array)
            model.invoke()
            return model.get_tensor(output_details[0]["index"]).tolist()

        raise ValueError(f"Unknown model type: {model_type}")


def do_unload(model_id):
    with _cache_lock:
        if model_id not in _models:
            raise ValueError(f"Model {model_id} not loaded")
        del _models[model_id]
        del _model_types[model_id]
        _model_locks.pop(model_id, None)
    return {"message": f"Model {model_id} unloaded"}


class InferenceHandler(BaseHTTPRequestHandler):
    # Silence the default per-request stderr logging; we emit our own.
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        _bump("requests_total")
        if self.path == "/health":
            with _cache_lock:
                loaded = len(_models)
            self._send(200, {"status": "healthy", "models_loaded": loaded})
        elif self.path == "/status":
            with _cache_lock:
                loaded_models = list(_models.keys())
                model_types = dict(_model_types)
            with _stats_lock:
                stats_snapshot = {
                    "requests_total": _stats["requests_total"],
                    "inference_total": _stats["inference_total"],
                    "errors_total": _stats["errors_total"],
                    "avg_inference_time_ms": round(_stats["avg_inference_time_ms"], 2),
                    "uptime_seconds": round(time.time() - _stats["start_time"], 1),
                }
            self._send(200, {
                "status": "running",
                "loaded_models": loaded_models,
                "model_types": model_types,
                "packages": _detect_packages(),
                "python_version": sys.version.split()[0],
                "stats": stats_snapshot,
            })
        else:
            self._send(404, {"success": False, "error": f"Not found: {self.path}"})

    def do_POST(self):
        _bump("requests_total")
        try:
            data = self._read_json()
        except (ValueError, json.JSONDecodeError) as e:
            _bump("errors_total")
            self._send(400, {"success": False, "error": f"Invalid JSON: {e}"})
            return

        try:
            if self.path == "/load":
                result = do_load(data.get("model_path"), data.get("model_id"))
                self._send(200, {"success": True, **result})

            elif self.path == "/predict":
                model_id = data.get("model_id")
                input_data = data.get("input_data")
                if not model_id:
                    self._send(400, {"success": False, "error": "model_id required"})
                    return
                if input_data is None:
                    self._send(400, {"success": False, "error": "input_data required"})
                    return
                start = time.time()
                prediction = do_predict(model_id, input_data, data.get("model_path"))
                inference_ms = (time.time() - start) * 1000.0
                _record_inference(inference_ms)
                self._send(200, {
                    "success": True,
                    "prediction": prediction,
                    "inference_time_ms": round(inference_ms, 2),
                })

            elif self.path == "/unload":
                model_id = data.get("model_id")
                if not model_id:
                    self._send(400, {"success": False, "error": "model_id required"})
                    return
                result = do_unload(model_id)
                self._send(200, {"success": True, **result})

            else:
                self._send(404, {"success": False, "error": f"Not found: {self.path}"})

        except FileNotFoundError as e:
            _bump("errors_total")
            self._send(404, {"success": False, "error": str(e)})
        except (ValueError, KeyError) as e:
            _bump("errors_total")
            self._send(400, {"success": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001 - surface any backend failure as 500
            _bump("errors_total")
            self._send(500, {"success": False, "error": str(e),
                             "traceback": traceback.format_exc()})


def main():
    host = os.environ.get("CM_INFERENCE_HOST", "0.0.0.0")
    port = int(os.environ.get("CM_INFERENCE_PORT", 8770))

    print("=" * 60, flush=True)
    print("Remote Inference Server for Node-RED Condition Monitoring", flush=True)
    print("=" * 60, flush=True)
    print(f"Listening on:  http://{host}:{port}", flush=True)
    print(f"Health check:  http://{host}:{port}/health", flush=True)
    print(f"Packages:      {', '.join(_detect_packages()) or 'none'}", flush=True)
    print("=" * 60, flush=True)

    server = ThreadingHTTPServer((host, port), InferenceHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[Inference Server] Shutting down", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
