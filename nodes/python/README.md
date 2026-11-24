# Python Scripts

This directory contains Python scripts for ML inference backends.

## Files

### python_bridge.py
Main Python bridge for ML inference. Communicates with Node.js via JSON over stdin/stdout.

**Supported frameworks:**
- TensorFlow Lite (`.tflite`)
- Keras (`.h5`, `.keras`) — loaded with `safe_mode=True` where the installed
  Keras supports it (tf.keras >= 2.13, Keras 3), which refuses Python lambdas
  embedded in `Lambda` layers. The legacy `.h5` loader of some Keras versions
  ignores `safe_mode`, so a downloaded `.h5` is never auto-selected on the
  Node-RED side: choose the Keras model type explicitly, like a pickle.
- scikit-learn (`.pkl`, `.joblib`)

**Usage:** Automatically spawned by `python-bridge-manager.js`. The manager
caps in-flight requests (64; further requests fail immediately with `EBUSY`)
and refuses to respawn a crashed interpreter for 30 s, or until 10 min after
the 5th crash in 10 min — one bad model is no longer one respawn per message.

### inference_server.py
Remote inference server — the **HTTP sibling of `python_bridge.py`**. Serves the
same TFLite/Keras/scikit-learn models from a separate sidecar container so the ML
runtime lives outside Node-RED. Reuses the model loaders from `python_bridge.py`
so the two backends cannot drift apart. Standard-library only (no Flask).

**Endpoints:** `GET /health`, `GET /status`, `POST /load`, `POST /predict`,
`POST /unload` (port `8770`).

**Usage:** Selected automatically when `CM_INFERENCE_URL` is set on the Node-RED
side (`nodes/remote-python-bridge.js` is the client). See
[`docs/REMOTE-INFERENCE.md`](../../docs/REMOTE-INFERENCE.md) and
`Dockerfile.inference`.

**Environment:**

| Variable | Default | Meaning |
| --- | --- | --- |
| `CM_INFERENCE_HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` in a container (the supplied Dockerfile/compose files do). |
| `CM_INFERENCE_PORT` | `8770` | Bind port. |
| `CM_INFERENCE_TOKEN` | unset | Shared secret. When set, every request except `GET /health` needs `Authorization: Bearer <token>` (or `X-Bridge-Token: <token>`), else `401`. Set the same variable on the Node-RED side and the client sends it. |
| `CM_INFERENCE_MODEL_ROOT` | `/data/models` | Directories (`os.pathsep`-separated) a client-supplied `model_path` must resolve into (symlinks resolved); anything else is `403`. |
| `CM_INFERENCE_MAX_MODELS` | `0` (unlimited) | LRU cap on resident models. |

### max_bridge.py
HTTP server for MAX Engine integration. Provides optimized ONNX inference.

**Endpoints:**
- `GET /health` - Health check
- `GET /status` - Server status
- `POST /load` - Load model
- `POST /predict` - Run inference
- `POST /unload` - Unload model

**Usage:** Run as Docker container or standalone server on port 8765

**Environment:**

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_BRIDGE_HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` in a container (as `docker-compose.dev.yml` does). |
| `MAX_BRIDGE_PORT` | `8765` | Bind port. |
| `MAX_BRIDGE_TOKEN` | unset | Shared secret, same rules as `CM_INFERENCE_TOKEN` above; the Node-RED client (`max-bridge-manager.js`) sends it when the same variable is set there. |
| `MAX_BRIDGE_MODEL_ROOT` | `/models` | Allowed model directories, same rules as `CM_INFERENCE_MODEL_ROOT`. |

## Network trust (both HTTP servers)

Both servers open whatever file a client names — `inference_server.py` will
even unpickle it — so they must only be reachable by their Node-RED:

- They bind to **loopback by default**. Exposing them further is an explicit
  decision (`*_HOST=0.0.0.0`), ideally on a private Docker network.
- Set the **shared token** on both ends whenever anything but the Node-RED
  process can reach the port. `GET /health` stays open for container health
  checks; it reveals only liveness and a model count.
- `model_path` is accepted only below the **model root(s)**; the roots are
  printed at startup and not echoed in error responses.
- Backend errors return `ExceptionClass: message` only. **Tracebacks go to the
  server's stderr**, never to the client.
- The Node-RED clients never retry a timed-out request (the server is still
  executing it) and retry a `5xx` only for `GET /status`.

### coral_inference.py
Google Coral Edge TPU inference script for hardware-accelerated ML.

**Requirements:**
- Google Coral USB Accelerator or Dev Board
- PyCoral library
- TensorFlow Lite models compiled for Edge TPU

## Requirements

```bash
pip install numpy tensorflow tflite-runtime scikit-learn
# For Coral: pip install pycoral
```
