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

# Install Python ML packages for TFLite, Keras, and scikit-learn support
RUN pip3 install --break-system-packages --no-cache-dir \
    tflite-runtime \
    scikit-learn \
    joblib \
    2>/dev/null || \
    pip3 install --break-system-packages --no-cache-dir \
    tensorflow-cpu \
    scikit-learn \
    joblib \
    2>/dev/null || \
    echo "Some Python ML packages installation skipped"

# Switch to node-red user for npm installs
USER node-red

# Install ML Runtime dependencies and required packages
WORKDIR /usr/src/node-red
RUN npm install @tensorflow/tfjs-node@4.22.0 onnxruntime-node@1.20.0 ml-isolation-forest@0.1.0 simple-statistics@7.8.2

# Copy the condition-monitoring module
COPY --chown=node-red:node-red . /data/node_modules/node-red-contrib-condition-monitoring/

# Working directory
WORKDIR /usr/src/node-red

