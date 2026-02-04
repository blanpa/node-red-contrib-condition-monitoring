#!/usr/bin/env python3
"""
Train and export ONNX models using PyTorch for Node-RED Condition Monitoring

This script creates all required ONNX models:
1. Sensor Anomaly Detection (5 inputs) - for simple sensor monitoring
2. Multi-Sensor Anomaly Detection (10 inputs) - for complex systems  
3. Simple Image Classifier (simulated) - for defect detection demo
"""

import os
import json
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, 'models')


def train_sensor_anomaly_model():
    """
    Train a 5-sensor anomaly detection model.
    Simple model for basic sensor monitoring.
    """
    print("\n" + "="*60)
    print("Training 5-Sensor Anomaly Model (ONNX)")
    print("="*60)
    
    torch.manual_seed(42)
    np.random.seed(42)
    
    n_samples = 5000
    n_features = 5
    
    # Generate data
    print("\nGenerating synthetic data...")
    
    # Normal data (85%)
    n_normal = int(n_samples * 0.85)
    normal_means = np.array([0.5, 0.45, 0.55, 0.48, 0.52])
    normal_data = np.random.normal(loc=normal_means, scale=0.1, size=(n_normal, n_features))
    normal_data = np.clip(normal_data, 0, 1)
    normal_labels = np.zeros(n_normal)
    
    # Anomaly data (15%)
    n_anomaly = n_samples - n_normal
    anomaly_data = []
    
    for _ in range(n_anomaly):
        anomaly_type = np.random.choice([0, 1, 2])
        base = np.random.normal(normal_means, 0.1)
        
        if anomaly_type == 0:  # Spike
            idx = np.random.randint(0, 5)
            base[idx] = np.random.uniform(0.85, 1.0)
        elif anomaly_type == 1:  # Drop
            idx = np.random.randint(0, 5)
            base[idx] = np.random.uniform(0.0, 0.15)
        else:  # Multiple anomalies
            indices = np.random.choice(5, size=2, replace=False)
            base[indices[0]] = np.random.uniform(0.8, 1.0)
            base[indices[1]] = np.random.uniform(0.0, 0.2)
        
        anomaly_data.append(np.clip(base, 0, 1))
    
    anomaly_data = np.array(anomaly_data)
    anomaly_labels = np.ones(n_anomaly)
    
    X = np.vstack([normal_data, anomaly_data]).astype(np.float32)
    y = np.hstack([normal_labels, anomaly_labels]).astype(np.float32)
    
    indices = np.random.permutation(len(X))
    X, y = X[indices], y[indices]
    
    # Split
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"Training samples: {len(X_train)}")
    print(f"Test samples: {len(X_test)}")
    
    # Create model
    class SensorAnomalyNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(5, 16),
                nn.ReLU(),
                nn.Dropout(0.2),
                nn.Linear(16, 8),
                nn.ReLU(),
                nn.Dropout(0.1),
                nn.Linear(8, 1),
                nn.Sigmoid()
            )
        
        def forward(self, x):
            return self.net(x)
    
    model = SensorAnomalyNet()
    criterion = nn.BCELoss()
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    
    # Train
    print("\nTraining...")
    train_dataset = TensorDataset(torch.FloatTensor(X_train), torch.FloatTensor(y_train).unsqueeze(1))
    train_loader = DataLoader(train_dataset, batch_size=64, shuffle=True)
    
    for epoch in range(20):
        model.train()
        total_loss = 0
        for batch_X, batch_y in train_loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        if (epoch + 1) % 5 == 0:
            print(f"Epoch {epoch+1}/20 - Loss: {total_loss/len(train_loader):.4f}")
    
    # Evaluate
    model.eval()
    with torch.no_grad():
        test_outputs = model(torch.FloatTensor(X_test))
        predictions = (test_outputs > 0.5).float()
        accuracy = (predictions.squeeze() == torch.FloatTensor(y_test)).float().mean()
        print(f"\nTest Accuracy: {accuracy:.4f}")
    
    # Export to ONNX
    output_path = os.path.join(MODELS_DIR, 'sensor-anomaly-onnx')
    os.makedirs(output_path, exist_ok=True)
    onnx_path = os.path.join(output_path, 'model.onnx')
    
    dummy_input = torch.randn(1, 5)
    torch.onnx.export(
        model, dummy_input, onnx_path,
        export_params=True, opset_version=13,
        input_names=['input'], output_names=['output'],
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}}
    )
    
    print(f"✓ Model saved to: {onnx_path}")
    
    # Metadata
    with open(os.path.join(output_path, 'metadata.json'), 'w') as f:
        json.dump({
            'model_type': 'onnx',
            'input_shape': [5],
            'features': ['temperature', 'pressure', 'vibration', 'current', 'flow'],
            'description': '5-sensor anomaly detection',
            'accuracy': float(accuracy)
        }, f, indent=2)
    
    return model


def train_defect_detector_model():
    """
    Train a simple defect detection model.
    Uses simulated image features (64 values representing 8x8 features).
    """
    print("\n" + "="*60)
    print("Training Defect Detection Model (ONNX)")
    print("="*60)
    
    torch.manual_seed(123)
    np.random.seed(123)
    
    n_samples = 3000
    n_features = 64  # 8x8 feature map
    n_classes = 5    # good, scratch, crack, corrosion, dent
    
    # Generate synthetic feature data
    print("\nGenerating synthetic image features...")
    
    X = []
    y = []
    
    for _ in range(n_samples):
        class_idx = np.random.randint(0, n_classes)
        
        # Base pattern
        features = np.random.normal(0.5, 0.1, n_features)
        
        if class_idx == 0:  # Good - uniform features
            pass
        elif class_idx == 1:  # Scratch - linear pattern
            line_idx = np.random.choice(8)
            features[line_idx*8:(line_idx+1)*8] = np.random.uniform(0.8, 1.0, 8)
        elif class_idx == 2:  # Crack - branching pattern
            center = np.random.randint(20, 44)
            for offset in [-9, -8, -7, -1, 0, 1, 7, 8, 9]:
                if 0 <= center + offset < 64:
                    features[center + offset] = np.random.uniform(0.7, 0.95)
        elif class_idx == 3:  # Corrosion - scattered spots
            spots = np.random.choice(64, size=15, replace=False)
            features[spots] = np.random.uniform(0.2, 0.4, 15)
        elif class_idx == 4:  # Dent - circular depression
            center = np.random.randint(18, 46)
            for offset in [-9, -8, -7, -1, 0, 1, 7, 8, 9]:
                if 0 <= center + offset < 64:
                    features[center + offset] = np.random.uniform(0.1, 0.3)
        
        X.append(np.clip(features, 0, 1))
        y.append(class_idx)
    
    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.int64)
    
    # Split
    indices = np.random.permutation(len(X))
    X, y = X[indices], y[indices]
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"Training samples: {len(X_train)}")
    print(f"Test samples: {len(X_test)}")
    print(f"Classes: {n_classes}")
    
    # Create model
    class DefectClassifier(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(64, 32),
                nn.ReLU(),
                nn.Dropout(0.3),
                nn.Linear(32, 16),
                nn.ReLU(),
                nn.Dropout(0.2),
                nn.Linear(16, 5),
                nn.Softmax(dim=1)
            )
        
        def forward(self, x):
            return self.net(x)
    
    model = DefectClassifier()
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    
    # Train
    print("\nTraining...")
    train_dataset = TensorDataset(torch.FloatTensor(X_train), torch.LongTensor(y_train))
    train_loader = DataLoader(train_dataset, batch_size=64, shuffle=True)
    
    for epoch in range(30):
        model.train()
        total_loss = 0
        for batch_X, batch_y in train_loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        if (epoch + 1) % 10 == 0:
            print(f"Epoch {epoch+1}/30 - Loss: {total_loss/len(train_loader):.4f}")
    
    # Evaluate
    model.eval()
    with torch.no_grad():
        test_outputs = model(torch.FloatTensor(X_test))
        predictions = test_outputs.argmax(dim=1)
        accuracy = (predictions == torch.LongTensor(y_test)).float().mean()
        print(f"\nTest Accuracy: {accuracy:.4f}")
    
    # Export to ONNX
    output_path = os.path.join(MODELS_DIR, 'defect-detector-onnx')
    os.makedirs(output_path, exist_ok=True)
    onnx_path = os.path.join(output_path, 'model.onnx')
    
    dummy_input = torch.randn(1, 64)
    torch.onnx.export(
        model, dummy_input, onnx_path,
        export_params=True, opset_version=13,
        input_names=['input'], output_names=['output'],
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}}
    )
    
    print(f"✓ Model saved to: {onnx_path}")
    
    # Metadata
    with open(os.path.join(output_path, 'metadata.json'), 'w') as f:
        json.dump({
            'model_type': 'onnx',
            'input_shape': [64],
            'classes': ['good', 'scratch', 'crack', 'corrosion', 'dent'],
            'description': 'Defect classification from 8x8 feature map',
            'accuracy': float(accuracy)
        }, f, indent=2)
    
    return model


if __name__ == '__main__':
    print("="*60)
    print("Training ONNX Models for Node-RED Condition Monitoring")
    print("="*60)
    
    train_sensor_anomaly_model()
    train_defect_detector_model()
    
    print("\n" + "="*60)
    print("✓ All ONNX models trained successfully!")
    print("="*60)
    
    print("\n📦 Generated Models:")
    print("  1. sensor-anomaly-onnx/model.onnx  - 5-sensor anomaly detection")
    print("  2. onnx-anomaly/model.onnx         - 10-sensor anomaly detection (already exists)")
    print("  3. defect-detector-onnx/model.onnx - Defect classification")
    
    print("\n🔧 To use in Node-RED, update flows.json with these paths:")
    print("  - /data/models/sensor-anomaly-onnx/model.onnx")
    print("  - /data/models/onnx-anomaly/model.onnx")
    print("  - /data/models/defect-detector-onnx/model.onnx")
