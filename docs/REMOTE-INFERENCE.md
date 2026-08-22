# Remote Inference Sidecar

Run the Python ML path (TensorFlow Lite, Keras, scikit-learn) in a **separate
container** instead of as a subprocess inside Node-RED.

## Why

The `ml-inference` node has two backends for `.tflite` / `.keras` / `.h5` /
`.pkl` / `.joblib` models:

| Mode | Transport | When |
| --- | --- | --- |
| **Local** (default) | Python **subprocess** inside the Node-RED container (`python_bridge.py` over stdin/stdout) | Single container, ML runtime baked into the Node-RED image. |
| **Remote** (this doc) | **HTTP** to a sidecar container (`inference_server.py`) | ML runtime isolated from Node-RED. |

Remote mode keeps the heavy ML stack (TensorFlow, scikit-learn, native libs) out
of the Node-RED image and **off the Node-RED event loop**. A crashing or
OOM-ing model takes down the sidecar, not Node-RED, and the inference service
can be scaled or GPU-pinned independently.

> ONNX models are unaffected — they run via `onnxruntime-node` in-process, or via
> the separate **MAX Engine** server (`max-bridge-manager.js`). This sidecar is
> specifically for the Python-backed formats.

## How it is wired

```
┌────────────────────────┐         HTTP /load /predict /unload        ┌──────────────────────────┐
│ Node-RED               │ ──────────────────────────────────────────▶│ inference sidecar         │
│  ml-inference node     │                                            │  inference_server.py      │
│  └ python-bridge-mgr   │   getGlobalBridge() picks transport by      │  └ python_bridge loaders  │
│     └ RemotePythonBridge│   $CM_INFERENCE_URL                         │     (keras/sklearn/tflite)│
└────────────────────────┘                                            └──────────────────────────┘
        shared models volume, mounted at the SAME path in both containers
```

`getGlobalBridge()` in `python-bridge-manager.js` chooses the transport **once**:

- `CM_INFERENCE_URL` set → `RemotePythonBridge` (HTTP client).
- unset/empty → the in-process subprocess bridge (unchanged default).

Both expose the same `start / loadModel / predict / unloadModel / stop`
surface, so the node code is identical either way. No per-node configuration
changes.

## Path requirement (important)

Model paths are resolved on the Node-RED side and sent to the sidecar verbatim.
**The same path must point at the same file in both containers.** The supplied
`docker-compose.yml` mounts `./test-models` at `/data/models` in *both*
services, so a model at `/data/models/m.tflite` resolves identically. Keep that
invariant if you change the mounts.

## Run it (Docker Compose)

The sidecar lives behind a compose **profile**, so the default `up` is unchanged:

```bash
# Default: everything in one container (local subprocess bridge)
NODE_RED_PORT=1890 docker compose -p cm-latest up -d

# With the remote sidecar: build + start `inference` and point Node-RED at it
CM_INFERENCE_URL=http://inference:8770 \
  NODE_RED_PORT=1890 \
  docker compose -p cm-latest --profile inference up -d --build
```

Verify the sidecar:

```bash
curl http://localhost:8770/health      # {"status":"healthy","models_loaded":0}
curl http://localhost:8770/status      # loaded models, packages, stats
```

## Run it standalone (no Compose)

```bash
docker build -f Dockerfile.inference -t cm-inference .
docker run -p 8770:8770 -v "$PWD/test-models:/data/models:ro" cm-inference

# then start Node-RED with:  CM_INFERENCE_URL=http://localhost:8770
```

Or directly, for development:

```bash
CM_INFERENCE_PORT=8770 python3 nodes/python/inference_server.py
```

## HTTP API

JSON in / JSON out. Same wire contract the local bridge uses internally.

| Method | Path | Body | Success response |
| --- | --- | --- | --- |
| GET | `/health` | — | `{"status":"healthy","models_loaded":N}` |
| GET | `/status` | — | loaded models, packages, stats |
| POST | `/load` | `{"model_path","model_id"}` | `{"success":true,"model_id","model_type"}` |
| POST | `/predict` | `{"model_id","input_data":[...]}` | `{"success":true,"prediction":[...],"inference_time_ms"}` |
| POST | `/unload` | `{"model_id"}` | `{"success":true}` |

Errors return `{"success":false,"error":"..."}` with `400` (bad request),
`404` (missing file / model not loaded) or `500` (backend failure). The client
retries `5xx`/transport failures but never `4xx`.

## Scaling & load distribution

**Within one replica (concurrency).** The server is multi-threaded, so requests
run in parallel. A short lock guards the model registry; each model has its own
lock held only for the actual inference call. So predicts on *different* models
run concurrently, while predicts on the *same* model are serialized — required
because a TFLite `Interpreter` (and Keras `predict`) is not thread-safe. A slow
model *load* runs outside the registry lock and never blocks inference on
already-loaded models.

**Across replicas (horizontal).** Two modes, depending on whether you want fixed
addressable workers or an elastic `replicas: N` knob.

### Mode 1 — Named workers, sharded by `model_id`

`CM_INFERENCE_URL` lists several replica URLs (comma-separated). The client
shards by a consistent hash of `model_id`, so a model's `load` and every later
`predict`/`unload` always hit the **same** replica — the stateful in-memory
cache stays correct **without an external load balancer**, distinct models
spread across replicas, and each model is resident on exactly one worker.

```bash
CM_INFERENCE_URL=http://inference1:8770,http://inference2:8770
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --build
```

The shard map is modulo the replica count, so **treat the list as fixed for a
deployment** — adding/removing a worker reshards; restart Node-RED to re-shard.
`getStatus()` aggregates all replicas (`{ replicas, replicaCount, totalModels }`).

### Mode 2 — `deploy.replicas: N` behind one service name (load-on-demand)

Point `CM_INFERENCE_URL` at a **single** service name backed by N containers.
Docker's DNS round-robins requests across them, and each `predict` carries the
model path so a replica that never received the explicit `/load` (or that lost
its cache after a restart) **loads the model on demand**. Any replica can serve
any request → elastic: scale `replicas` up/down freely.

```bash
CM_INFERENCE_URL=http://inference:8770          # one name, N containers
docker compose -f docker-compose.replicas.yml up -d --build --scale inference=3
```

Trade-offs: a model may become resident on several replicas (memory up to ×N —
bound it with `CM_INFERENCE_MAX_MODELS`, which enables LRU eviction); the first
hit on a replica pays a cold-start load; `unload` only reaches one replica, so
rely on LRU rather than explicit unload here.

| | Mode 1: named workers | Mode 2: `replicas: N` |
| --- | --- | --- |
| `CM_INFERENCE_URL` | list of URLs | one service name |
| Routing | client hash on `model_id` | Docker DNS round-robin |
| Model residency | 1 worker per model | up to ×N (LRU-bounded) |
| Elastic scaling | no (re-shard on change) | **yes** |
| Cold start | no | yes (per replica/model) |
| External LB | no | no |

**When to reach for real serving infra.** Client-side sharding fits the common
Node-RED case (many nodes, each its own model). For *elastic autoscaling*,
request **batching**, GPU sharing or a single model served by many replicas,
front a single `CM_INFERENCE_URL` with a dedicated model server — **NVIDIA
Triton** (HTTP, could replace `inference_server.py`), **KServe** or **Ray
Serve** — rather than growing this server into a cluster scheduler. Note also
that Node-RED itself is a single event loop: inference offload removes the ML
load, but extreme message rates may need multiple Node-RED instances too.

## Tuning the image

`Dockerfile.inference` installs `numpy`, `scikit-learn`, `joblib`,
`tflite-runtime` and (best-effort) `tensorflow-cpu`. Drop `tensorflow-cpu` if
you do not run Keras models — it is by far the largest layer. For GPU Keras
inference, swap the base image for a CUDA-enabled TensorFlow image.

## Limitations

- Throughput per replica is bounded by per-model serialization (same-model
  predicts cannot overlap) and the lack of request batching. Scale out with
  replicas (above) or move to a batching model server for GPU saturation.
- There is no authentication on the HTTP API — keep the sidecar on a private
  Docker network (as in the supplied compose), not exposed to the internet.
- ONNX / TF.js / MAX Engine paths are out of scope here (see the MAX server).
