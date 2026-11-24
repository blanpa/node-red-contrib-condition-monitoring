# Use Debian-based Node-RED image for glibc compatibility with ML runtimes
FROM nodered/node-red:latest-debian

# Install ML Runtimes as root
USER root

# Install build dependencies for native modules and Python for TFLite
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-numpy \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Python ML packages for TFLite, Keras, and scikit-learn support.
# Three separate steps on purpose: the small runtimes must not be lost when the
# heavy optional TensorFlow wheel is unavailable for the image's Python.
# TFLite runs on LiteRT (ai-edge-litert); tflite-runtime stopped at 2.14 and has
# no wheels for Python 3.12+.
RUN pip3 install --break-system-packages --no-cache-dir \
    numpy \
    scikit-learn \
    joblib
RUN pip3 install --break-system-packages --no-cache-dir ai-edge-litert
RUN pip3 install --break-system-packages --no-cache-dir tensorflow-cpu \
    || echo "tensorflow-cpu not installed (Keras/SavedModel models unavailable)"

# Switch to node-red user for npm installs
USER node-red

# Install ML Runtime dependencies and required packages
WORKDIR /usr/src/node-red
# Every package.json "dependencies" entry must be listed here: the module is
# copied in below without its own node_modules and resolves these via NODE_PATH.
# Versions follow package-lock.json (test/docker-deps_spec.js checks both).
RUN npm install \
        @tensorflow/tfjs-node@4.22.0 \
        onnxruntime-node@1.31.1 \
        fft.js@4.0.4 \
        jpeg-js@0.4.4 \
        ml-isolation-forest@0.1.0 \
        ml-matrix@6.15.1 \
        ml-pca@4.1.1 \
        pngjs@7.0.0 \
        simple-statistics@8.0.0

# Copy the condition-monitoring module
COPY --chown=node-red:node-red . /data/node_modules/node-red-contrib-condition-monitoring/

# Working directory
WORKDIR /usr/src/node-red

