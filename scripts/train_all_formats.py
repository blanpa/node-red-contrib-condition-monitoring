#!/usr/bin/env python3
"""
Train and export models in all supported formats for Node-RED Condition Monitoring

Supported formats:
1. ONNX (.onnx) - Open Neural Network Exchange
2. TFLite (.tflite) - TensorFlow Lite for edge devices
3. TensorFlow SavedModel (saved_model/) - Full TensorFlow format
4. TensorFlow.js (model.json + .bin) - For browser/Node.js

This script creates example models in each format.
"""

import os
import json
import numpy as np
import shutil

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, 'models')

# Check available libraries
HAS_TORCH = False
HAS_TF = False

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
    print("✓ PyTorch available")
except ImportError:
    print("✗ PyTorch not available")

try:
    import tensorflow as tf
    HAS_TF = True
    print("✓ TensorFlow available")
except ImportError:
    print("✗ TensorFlow not available")


def generate_sensor_data(n_samples=5000, n_features=5):
    """Generate synthetic sensor data for anomaly detection."""
    np.random.seed(42)
    
    # Normal data (85%)
    n_normal = int(n_samples * 0.85)
    normal_means = np.linspace(0.4, 0.6, n_features)
    normal_data = np.random.normal(loc=normal_means, scale=0.1, size=(n_normal, n_features))
    normal_data = np.clip(normal_data, 0, 1)
    normal_labels = np.zeros(n_normal)
    
    # Anomaly data (15%)
    n_anomaly = n_samples - n_normal
    anomaly_data = []
    
    for _ in range(n_anomaly):
        base = np.random.normal(normal_means, 0.1)
        anomaly_type = np.random.choice([0, 1, 2])
        
        if anomaly_type == 0:  # Spike
            idx = np.random.randint(0, n_features)
            base[idx] = np.random.uniform(0.85, 1.0)
        elif anomaly_type == 1:  # Drop
            idx = np.random.randint(0, n_features)
            base[idx] = np.random.uniform(0.0, 0.15)
        else:  # Multiple
            indices = np.random.choice(n_features, size=2, replace=False)
            base[indices[0]] = np.random.uniform(0.8, 1.0)
            base[indices[1]] = np.random.uniform(0.0, 0.2)
        
        anomaly_data.append(np.clip(base, 0, 1))
    
    anomaly_data = np.array(anomaly_data)
    anomaly_labels = np.ones(n_anomaly)
    
    X = np.vstack([normal_data, anomaly_data]).astype(np.float32)
    y = np.hstack([normal_labels, anomaly_labels]).astype(np.float32)
    
    indices = np.random.permutation(len(X))
    return X[indices], y[indices]


# ============================================================
# ONNX Model (PyTorch)
# ============================================================

def create_onnx_model():
    """Create ONNX model using PyTorch."""
    if not HAS_TORCH:
        print("\n⚠️ Skipping ONNX: PyTorch not available")
        return
    
    print("\n" + "="*60)
    print("Creating ONNX Model (.onnx)")
    print("="*60)
    
    torch.manual_seed(42)
    
    X, y = generate_sensor_data(n_samples=5000, n_features=5)
    
    # Simple model
    class SensorNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(5, 16),
                nn.ReLU(),
                nn.Linear(16, 8),
                nn.ReLU(),
                nn.Linear(8, 1),
                nn.Sigmoid()
            )
        
        def forward(self, x):
            return self.net(x)
    
    model = SensorNet()
    criterion = nn.BCELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    
    # Quick training
    print("Training...")
    from torch.utils.data import DataLoader, TensorDataset
    dataset = TensorDataset(torch.FloatTensor(X), torch.FloatTensor(y).unsqueeze(1))
    loader = DataLoader(dataset, batch_size=64, shuffle=True)
    
    for epoch in range(15):
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            loss = criterion(model(batch_X), batch_y)
            loss.backward()
            optimizer.step()
    
    # Export to ONNX
    output_dir = os.path.join(MODELS_DIR, 'sensor-onnx')
    os.makedirs(output_dir, exist_ok=True)
    onnx_path = os.path.join(output_dir, 'model.onnx')
    
    model.eval()
    dummy = torch.randn(1, 5)
    torch.onnx.export(
        model, dummy, onnx_path,
        export_params=True,
        opset_version=13,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}}
    )
    
    # Metadata
    with open(os.path.join(output_dir, 'metadata.json'), 'w') as f:
        json.dump({
            'format': 'onnx',
            'file': 'model.onnx',
            'input_shape': [5],
            'output': 'anomaly_probability',
            'description': 'Sensor anomaly detection (ONNX/PyTorch)'
        }, f, indent=2)
    
    print(f"✓ Saved: {onnx_path}")


# ============================================================
# TFLite Model (.tflite)
# ============================================================

def create_tflite_model():
    """Create TFLite model using TensorFlow."""
    if not HAS_TF:
        print("\n⚠️ Skipping TFLite: TensorFlow not available")
        return
    
    print("\n" + "="*60)
    print("Creating TFLite Model (.tflite)")
    print("="*60)
    
    tf.random.set_seed(42)
    
    X, y = generate_sensor_data(n_samples=5000, n_features=5)
    
    # Create Keras model
    print("Building model...")
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(5,)),
        tf.keras.layers.Dense(16, activation='relu'),
        tf.keras.layers.Dense(8, activation='relu'),
        tf.keras.layers.Dense(1, activation='sigmoid')
    ])
    
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    
    # Train
    print("Training...")
    model.fit(X, y, epochs=15, batch_size=64, verbose=0)
    
    # Convert to TFLite
    print("Converting to TFLite...")
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    tflite_model = converter.convert()
    
    # Save .tflite file
    output_dir = os.path.join(MODELS_DIR, 'sensor-tflite')
    os.makedirs(output_dir, exist_ok=True)
    tflite_path = os.path.join(output_dir, 'model.tflite')
    
    with open(tflite_path, 'wb') as f:
        f.write(tflite_model)
    
    # Metadata
    with open(os.path.join(output_dir, 'metadata.json'), 'w') as f:
        json.dump({
            'format': 'tflite',
            'file': 'model.tflite',
            'input_shape': [5],
            'output': 'anomaly_probability',
            'description': 'Sensor anomaly detection (TFLite)',
            'optimizations': ['DEFAULT'],
            'compatible_with': ['Google Coral Edge TPU', 'TFLite Runtime', 'Mobile devices']
        }, f, indent=2)
    
    print(f"✓ Saved: {tflite_path}")
    print(f"  Size: {os.path.getsize(tflite_path):,} bytes")


# ============================================================
# TensorFlow SavedModel
# ============================================================

def create_savedmodel():
    """Create TensorFlow SavedModel directory."""
    if not HAS_TF:
        print("\n⚠️ Skipping SavedModel: TensorFlow not available")
        return
    
    print("\n" + "="*60)
    print("Creating TensorFlow SavedModel (saved_model/)")
    print("="*60)
    
    tf.random.set_seed(42)
    
    X, y = generate_sensor_data(n_samples=5000, n_features=5)
    
    # Create Keras model
    print("Building model...")
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(5,), name='sensor_input'),
        tf.keras.layers.Dense(16, activation='relu', name='hidden1'),
        tf.keras.layers.Dense(8, activation='relu', name='hidden2'),
        tf.keras.layers.Dense(1, activation='sigmoid', name='anomaly_output')
    ])
    
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    
    # Train
    print("Training...")
    model.fit(X, y, epochs=15, batch_size=64, verbose=0)
    
    # Save as SavedModel
    output_dir = os.path.join(MODELS_DIR, 'sensor-savedmodel')
    savedmodel_path = os.path.join(output_dir, 'saved_model')
    
    # Remove old if exists
    if os.path.exists(savedmodel_path):
        shutil.rmtree(savedmodel_path)
    
    os.makedirs(output_dir, exist_ok=True)
    # Use export() for Keras 3 to create SavedModel
    model.export(savedmodel_path)
    
    # Metadata
    with open(os.path.join(output_dir, 'metadata.json'), 'w') as f:
        json.dump({
            'format': 'savedmodel',
            'directory': 'saved_model/',
            'input_shape': [5],
            'input_name': 'sensor_input',
            'output_name': 'anomaly_output',
            'description': 'Sensor anomaly detection (TensorFlow SavedModel)',
            'tf_version': tf.__version__
        }, f, indent=2)
    
    print(f"✓ Saved: {savedmodel_path}/")


# ============================================================
# TensorFlow.js Model (model.json + .bin)
# ============================================================

def create_tfjs_model():
    """Create TensorFlow.js model."""
    if not HAS_TF:
        print("\n⚠️ Skipping TF.js: TensorFlow not available")
        return
    
    print("\n" + "="*60)
    print("Creating TensorFlow.js Model (model.json + .bin)")
    print("="*60)
    
    tf.random.set_seed(42)
    
    X, y = generate_sensor_data(n_samples=5000, n_features=5)
    
    # Create Keras model
    print("Building model...")
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(5,)),
        tf.keras.layers.Dense(16, activation='relu'),
        tf.keras.layers.Dense(8, activation='relu'),
        tf.keras.layers.Dense(1, activation='sigmoid')
    ])
    
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    
    # Train
    print("Training...")
    model.fit(X, y, epochs=15, batch_size=64, verbose=0)
    
    # First save as SavedModel, then convert
    output_dir = os.path.join(MODELS_DIR, 'sensor-tfjs')
    temp_saved = os.path.join(output_dir, 'temp_saved')
    tfjs_path = os.path.join(output_dir, 'tfjs')
    
    os.makedirs(output_dir, exist_ok=True)
    
    # Save temp as SavedModel
    model.export(temp_saved)
    
    # Convert to TF.js using tensorflowjs_converter
    print("Converting to TensorFlow.js...")
    import subprocess
    result = subprocess.run([
        'tensorflowjs_converter',
        '--input_format=tf_saved_model',
        '--output_format=tfjs_graph_model',
        temp_saved,
        tfjs_path
    ], capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"⚠️ TF.js conversion failed: {result.stderr}")
        # Cleanup
        shutil.rmtree(temp_saved, ignore_errors=True)
        return
    
    # Cleanup temp
    shutil.rmtree(temp_saved, ignore_errors=True)
    
    # Metadata
    with open(os.path.join(output_dir, 'metadata.json'), 'w') as f:
        json.dump({
            'format': 'tfjs',
            'directory': 'tfjs/',
            'main_file': 'tfjs/model.json',
            'input_shape': [5],
            'description': 'Sensor anomaly detection (TensorFlow.js)',
            'compatible_with': ['Node.js (tfjs-node)', 'Browser', 'React Native']
        }, f, indent=2)
    
    print(f"✓ Saved: {tfjs_path}/model.json")


# ============================================================
# Main
# ============================================================

def main():
    print("="*60)
    print("Training Models in All Supported Formats")
    print("="*60)
    
    create_onnx_model()
    create_tflite_model()
    create_savedmodel()
    create_tfjs_model()
    
    print("\n" + "="*60)
    print("Summary of Created Models")
    print("="*60)
    
    print("\n📦 Models Directory Structure:")
    for item in sorted(os.listdir(MODELS_DIR)):
        item_path = os.path.join(MODELS_DIR, item)
        if os.path.isdir(item_path):
            print(f"\n  {item}/")
            for subitem in sorted(os.listdir(item_path)):
                subpath = os.path.join(item_path, subitem)
                if os.path.isfile(subpath):
                    size = os.path.getsize(subpath)
                    print(f"    ├── {subitem} ({size:,} bytes)")
                elif os.path.isdir(subpath):
                    print(f"    ├── {subitem}/")
    
    print("\n" + "="*60)
    print("Model Format Reference")
    print("="*60)
    print("""
Format          | File Extension      | Use Case
----------------|---------------------|----------------------------------
ONNX            | .onnx               | Cross-platform, PyTorch models
TFLite          | .tflite             | Mobile, Edge TPU, IoT devices
SavedModel      | saved_model/        | Full TensorFlow, serving
TensorFlow.js   | model.json + .bin   | Browser, Node.js

Node-RED ML Inference Node Paths:
  - ONNX:       /data/models/sensor-onnx/model.onnx
  - TFLite:     /data/models/sensor-tflite/model.tflite
  - SavedModel: /data/models/sensor-savedmodel/saved_model
  - TF.js:      /data/models/sensor-tfjs/tfjs/model.json
""")


if __name__ == '__main__':
    main()
