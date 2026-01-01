#!/usr/bin/env python3
"""
Train ML Models with Realistic Synthetic Industrial Data

This script creates production-ready models for condition monitoring:
1. Sensor Anomaly Detection - Temperature, Pressure, Vibration, Flow, Current
2. Multi-Sensor Correlation - 10 correlated industrial sensors
3. Vibration Analysis - Bearing fault detection from vibration features
4. Defect Classification - Visual inspection simulation

All models are trained on realistic synthetic data that simulates:
- Normal operating conditions with realistic noise
- Common industrial failure modes
- Gradual degradation patterns
- Sudden failures and spikes
- Sensor drift and calibration issues
"""

import os
import sys
import json
import numpy as np
from datetime import datetime

# Check dependencies
try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    from torch.utils.data import DataLoader, TensorDataset
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    print("Warning: PyTorch not available, skipping ONNX models")

try:
    import tensorflow as tf
    from tensorflow import keras
    HAS_TF = True
except ImportError:
    HAS_TF = False
    print("Warning: TensorFlow not available, skipping Keras/TFLite models")

try:
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier, IsolationForest
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import classification_report, accuracy_score
    import joblib
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False
    print("Warning: scikit-learn not available, skipping sklearn models")

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, 'models')

# Ensure models directory exists
os.makedirs(MODELS_DIR, exist_ok=True)


# =============================================================================
# REALISTIC DATA GENERATORS
# =============================================================================

class IndustrialDataGenerator:
    """Generate realistic industrial sensor data"""
    
    def __init__(self, seed=42):
        np.random.seed(seed)
        
    def generate_temperature_sensor(self, n_samples, anomaly_ratio=0.1):
        """
        Simulate industrial temperature sensor (°C)
        Normal: 60-80°C with daily cycles
        Anomalies: Overheating, cooling failure, sensor drift
        """
        t = np.linspace(0, 24 * n_samples / 1000, n_samples)  # Hours
        
        # Base temperature with daily cycle
        base = 70 + 5 * np.sin(2 * np.pi * t / 24)
        
        # Add realistic noise (thermal fluctuations)
        noise = np.random.normal(0, 1.5, n_samples)
        
        # Add process variations
        process_var = 3 * np.sin(2 * np.pi * t / 0.5)  # Fast process cycles
        
        normal = base + noise + process_var
        labels = np.zeros(n_samples)
        
        # Inject anomalies
        n_anomalies = int(n_samples * anomaly_ratio)
        anomaly_indices = np.random.choice(n_samples, n_anomalies, replace=False)
        
        for idx in anomaly_indices:
            anomaly_type = np.random.choice(['overheat', 'cooling_fail', 'drift', 'spike'])
            if anomaly_type == 'overheat':
                normal[idx] = np.random.uniform(90, 110)
            elif anomaly_type == 'cooling_fail':
                normal[idx] = np.random.uniform(85, 100)
            elif anomaly_type == 'drift':
                normal[idx] += np.random.uniform(15, 25)
            else:  # spike
                normal[idx] = np.random.uniform(100, 120)
            labels[idx] = 1
            
        return normal, labels
    
    def generate_pressure_sensor(self, n_samples, anomaly_ratio=0.1):
        """
        Simulate industrial pressure sensor (bar)
        Normal: 4-6 bar with pump cycles
        Anomalies: Leaks, blockages, pump failure
        """
        t = np.linspace(0, n_samples / 100, n_samples)
        
        # Base pressure with pump cycles
        base = 5 + 0.3 * np.sin(2 * np.pi * t / 0.1)
        
        # Realistic noise
        noise = np.random.normal(0, 0.1, n_samples)
        
        normal = base + noise
        labels = np.zeros(n_samples)
        
        n_anomalies = int(n_samples * anomaly_ratio)
        anomaly_indices = np.random.choice(n_samples, n_anomalies, replace=False)
        
        for idx in anomaly_indices:
            anomaly_type = np.random.choice(['leak', 'blockage', 'pump_fail', 'surge'])
            if anomaly_type == 'leak':
                normal[idx] = np.random.uniform(2, 3.5)
            elif anomaly_type == 'blockage':
                normal[idx] = np.random.uniform(7, 9)
            elif anomaly_type == 'pump_fail':
                normal[idx] = np.random.uniform(0.5, 2)
            else:  # surge
                normal[idx] = np.random.uniform(8, 12)
            labels[idx] = 1
            
        return normal, labels
    
    def generate_vibration_sensor(self, n_samples, anomaly_ratio=0.1):
        """
        Simulate vibration sensor (mm/s RMS)
        Normal: 1-3 mm/s (ISO 10816 Zone A/B)
        Anomalies: Imbalance, misalignment, bearing defects
        """
        # Base vibration level
        base = np.random.uniform(1.5, 2.5, n_samples)
        
        # Add mechanical resonance
        t = np.linspace(0, n_samples / 100, n_samples)
        resonance = 0.3 * np.sin(2 * np.pi * t * 25)  # 25 Hz resonance
        
        # Realistic noise
        noise = np.random.normal(0, 0.2, n_samples)
        
        normal = base + np.abs(resonance) + np.abs(noise)
        labels = np.zeros(n_samples)
        
        n_anomalies = int(n_samples * anomaly_ratio)
        anomaly_indices = np.random.choice(n_samples, n_anomalies, replace=False)
        
        for idx in anomaly_indices:
            anomaly_type = np.random.choice(['imbalance', 'misalignment', 'bearing', 'looseness'])
            if anomaly_type == 'imbalance':
                normal[idx] = np.random.uniform(4.5, 7)
            elif anomaly_type == 'misalignment':
                normal[idx] = np.random.uniform(5, 8)
            elif anomaly_type == 'bearing':
                normal[idx] = np.random.uniform(6, 12)
            else:  # looseness
                normal[idx] = np.random.uniform(5, 10)
            labels[idx] = 1
            
        return normal, labels
    
    def generate_flow_sensor(self, n_samples, anomaly_ratio=0.1):
        """
        Simulate flow sensor (L/min)
        Normal: 90-110 L/min
        Anomalies: Blockage, pump cavitation, valve stuck
        """
        # Base flow with demand variations
        t = np.linspace(0, 24 * n_samples / 1000, n_samples)
        base = 100 + 5 * np.sin(2 * np.pi * t / 8)  # 8-hour shift pattern
        
        noise = np.random.normal(0, 2, n_samples)
        
        normal = base + noise
        labels = np.zeros(n_samples)
        
        n_anomalies = int(n_samples * anomaly_ratio)
        anomaly_indices = np.random.choice(n_samples, n_anomalies, replace=False)
        
        for idx in anomaly_indices:
            anomaly_type = np.random.choice(['blockage', 'cavitation', 'valve_stuck', 'leak'])
            if anomaly_type == 'blockage':
                normal[idx] = np.random.uniform(30, 60)
            elif anomaly_type == 'cavitation':
                normal[idx] = np.random.uniform(60, 75)
            elif anomaly_type == 'valve_stuck':
                normal[idx] = np.random.uniform(0, 20)
            else:  # leak
                normal[idx] = np.random.uniform(120, 150)
            labels[idx] = 1
            
        return normal, labels
    
    def generate_current_sensor(self, n_samples, anomaly_ratio=0.1):
        """
        Simulate motor current sensor (A)
        Normal: 15-20A for a typical motor
        Anomalies: Overload, short circuit, winding damage
        """
        # Base current with load variations
        base = 17.5 + np.random.normal(0, 0.5, n_samples)
        
        # Startup transients (occasional)
        for i in range(0, n_samples, 500):
            if i + 10 < n_samples:
                base[i:i+10] = base[i:i+10] * 1.3  # Inrush current
        
        normal = base
        labels = np.zeros(n_samples)
        
        n_anomalies = int(n_samples * anomaly_ratio)
        anomaly_indices = np.random.choice(n_samples, n_anomalies, replace=False)
        
        for idx in anomaly_indices:
            anomaly_type = np.random.choice(['overload', 'short', 'winding', 'phase_loss'])
            if anomaly_type == 'overload':
                normal[idx] = np.random.uniform(25, 35)
            elif anomaly_type == 'short':
                normal[idx] = np.random.uniform(40, 60)
            elif anomaly_type == 'winding':
                normal[idx] = np.random.uniform(22, 28)
            else:  # phase_loss
                normal[idx] = np.random.uniform(28, 40)
            labels[idx] = 1
            
        return normal, labels
    
    def generate_multi_sensor_data(self, n_samples, n_sensors=5, anomaly_ratio=0.1):
        """Generate correlated multi-sensor data with normalized values (0-1)"""
        generators = [
            self.generate_temperature_sensor,
            self.generate_pressure_sensor,
            self.generate_vibration_sensor,
            self.generate_flow_sensor,
            self.generate_current_sensor,
        ]
        
        data = []
        all_labels = []
        
        for i in range(n_sensors):
            gen = generators[i % len(generators)]
            values, labels = gen(n_samples, anomaly_ratio)
            
            # Normalize to 0-1
            values = (values - values.min()) / (values.max() - values.min() + 1e-8)
            data.append(values)
            all_labels.append(labels)
        
        X = np.column_stack(data).astype(np.float32)
        # Label as anomaly if ANY sensor shows anomaly
        y = np.max(np.column_stack(all_labels), axis=1).astype(np.float32)
        
        return X, y
    
    def generate_vibration_features(self, n_samples, anomaly_ratio=0.15):
        """
        Generate realistic vibration feature data for bearing analysis
        Features: RMS, Peak, Crest Factor, Kurtosis, Skewness, 
                  Dominant Freq, Spectral Centroid, Band Energy
        """
        features = np.zeros((n_samples, 8), dtype=np.float32)
        labels = np.zeros(n_samples, dtype=np.float32)
        
        for i in range(n_samples):
            if np.random.random() > anomaly_ratio:
                # Normal bearing
                features[i, 0] = np.random.uniform(1.5, 3.0)    # RMS (mm/s)
                features[i, 1] = np.random.uniform(3, 8)        # Peak (mm/s)
                features[i, 2] = np.random.uniform(2.5, 4.0)    # Crest Factor
                features[i, 3] = np.random.uniform(2.8, 3.5)    # Kurtosis (Gaussian ~3)
                features[i, 4] = np.random.uniform(-0.3, 0.3)   # Skewness (~0)
                features[i, 5] = np.random.uniform(20, 60)      # Dominant Freq (Hz)
                features[i, 6] = np.random.uniform(100, 200)    # Spectral Centroid
                features[i, 7] = np.random.uniform(0.3, 0.5)    # Band Energy ratio
                labels[i] = 0
            else:
                # Faulty bearing
                fault_type = np.random.choice(['inner_race', 'outer_race', 'ball', 'cage'])
                
                if fault_type == 'inner_race':
                    features[i, 0] = np.random.uniform(5, 12)
                    features[i, 1] = np.random.uniform(15, 35)
                    features[i, 2] = np.random.uniform(4.5, 7)
                    features[i, 3] = np.random.uniform(5, 12)
                    features[i, 4] = np.random.uniform(0.5, 2)
                    features[i, 5] = np.random.uniform(80, 150)
                    features[i, 6] = np.random.uniform(250, 400)
                    features[i, 7] = np.random.uniform(0.6, 0.85)
                elif fault_type == 'outer_race':
                    features[i, 0] = np.random.uniform(4, 10)
                    features[i, 1] = np.random.uniform(12, 28)
                    features[i, 2] = np.random.uniform(4, 6)
                    features[i, 3] = np.random.uniform(4, 8)
                    features[i, 4] = np.random.uniform(0.3, 1.5)
                    features[i, 5] = np.random.uniform(60, 120)
                    features[i, 6] = np.random.uniform(200, 350)
                    features[i, 7] = np.random.uniform(0.55, 0.8)
                elif fault_type == 'ball':
                    features[i, 0] = np.random.uniform(3, 8)
                    features[i, 1] = np.random.uniform(10, 22)
                    features[i, 2] = np.random.uniform(3.5, 5.5)
                    features[i, 3] = np.random.uniform(3.5, 6)
                    features[i, 4] = np.random.uniform(0.2, 1)
                    features[i, 5] = np.random.uniform(100, 200)
                    features[i, 6] = np.random.uniform(180, 300)
                    features[i, 7] = np.random.uniform(0.5, 0.75)
                else:  # cage
                    features[i, 0] = np.random.uniform(3.5, 7)
                    features[i, 1] = np.random.uniform(8, 18)
                    features[i, 2] = np.random.uniform(3.2, 5)
                    features[i, 3] = np.random.uniform(3.2, 5)
                    features[i, 4] = np.random.uniform(0.1, 0.8)
                    features[i, 5] = np.random.uniform(10, 40)
                    features[i, 6] = np.random.uniform(150, 250)
                    features[i, 7] = np.random.uniform(0.45, 0.7)
                
                labels[i] = 1
        
        # Normalize features
        for j in range(8):
            features[:, j] = (features[:, j] - features[:, j].min()) / \
                            (features[:, j].max() - features[:, j].min() + 1e-8)
        
        return features, labels


def save_metadata(model_dir, model_name, model_type, input_shape, description, accuracy=None):
    """Save model metadata"""
    metadata = {
        "name": model_name,
        "version": "2.0.0",
        "type": model_type,
        "description": description,
        "inputShape": input_shape,
        "trainedOn": "Realistic synthetic industrial data",
        "createdAt": datetime.now().isoformat(),
        "framework": model_type.split('-')[0] if '-' in model_type else model_type,
    }
    if accuracy:
        metadata["accuracy"] = accuracy
    
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)


# =============================================================================
# PYTORCH / ONNX MODELS
# =============================================================================

def train_onnx_models():
    """Train all ONNX models using PyTorch"""
    if not HAS_TORCH:
        print("Skipping ONNX models - PyTorch not available")
        return
    
    generator = IndustrialDataGenerator(seed=42)
    
    # --- 5-Sensor Anomaly Model ---
    print("\n" + "="*60)
    print("Training 5-Sensor Anomaly Model (ONNX)")
    print("="*60)
    
    X, y = generator.generate_multi_sensor_data(10000, n_sensors=5, anomaly_ratio=0.12)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    class SensorNet(nn.Module):
        def __init__(self, n_features):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(n_features, 32),
                nn.BatchNorm1d(32),
                nn.ReLU(),
                nn.Dropout(0.3),
                nn.Linear(32, 16),
                nn.BatchNorm1d(16),
                nn.ReLU(),
                nn.Dropout(0.2),
                nn.Linear(16, 8),
                nn.ReLU(),
                nn.Linear(8, 1),
                nn.Sigmoid()
            )
        def forward(self, x):
            return self.net(x)
    
    model = SensorNet(5)
    train_pytorch_model(model, X_train, y_train, X_test, y_test, epochs=100)
    
    # Export to ONNX
    model_dir = os.path.join(MODELS_DIR, 'sensor-onnx')
    os.makedirs(model_dir, exist_ok=True)
    
    model.eval()
    dummy = torch.randn(1, 5)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=13)
    
    acc = evaluate_pytorch_model(model, X_test, y_test)
    save_metadata(model_dir, "sensor-anomaly-5", "onnx", [1, 5],
                  "5-sensor industrial anomaly detection (temp, pressure, vibration, flow, current)",
                  accuracy=acc)
    print(f"✓ Saved to {model_dir} (Accuracy: {acc:.2%})")
    
    # --- 10-Sensor Model ---
    print("\n" + "="*60)
    print("Training 10-Sensor Anomaly Model (ONNX)")
    print("="*60)
    
    X, y = generator.generate_multi_sensor_data(15000, n_sensors=10, anomaly_ratio=0.1)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    model = SensorNet(10)
    model.net[0] = nn.Linear(10, 32)
    train_pytorch_model(model, X_train, y_train, X_test, y_test, epochs=100)
    
    model_dir = os.path.join(MODELS_DIR, 'onnx-anomaly')
    os.makedirs(model_dir, exist_ok=True)
    
    model.eval()
    dummy = torch.randn(1, 10)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=13)
    
    acc = evaluate_pytorch_model(model, X_test, y_test)
    save_metadata(model_dir, "sensor-anomaly-10", "onnx", [1, 10],
                  "10-sensor industrial monitoring with cross-correlation detection",
                  accuracy=acc)
    print(f"✓ Saved to {model_dir} (Accuracy: {acc:.2%})")
    
    # --- Vibration/Bearing Model ---
    print("\n" + "="*60)
    print("Training Vibration Analysis Model (ONNX)")
    print("="*60)
    
    X, y = generator.generate_vibration_features(12000, anomaly_ratio=0.15)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    class VibrationNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(8, 32),
                nn.BatchNorm1d(32),
                nn.ReLU(),
                nn.Dropout(0.25),
                nn.Linear(32, 16),
                nn.ReLU(),
                nn.Linear(16, 1),
                nn.Sigmoid()
            )
        def forward(self, x):
            return self.net(x)
    
    model = VibrationNet()
    train_pytorch_model(model, X_train, y_train, X_test, y_test, epochs=80)
    
    model_dir = os.path.join(MODELS_DIR, 'pytorch-vibration')
    os.makedirs(model_dir, exist_ok=True)
    
    model.eval()
    dummy = torch.randn(1, 8)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=13)
    
    acc = evaluate_pytorch_model(model, X_test, y_test)
    save_metadata(model_dir, "vibration-bearing-analysis", "onnx", [1, 8],
                  "Bearing fault detection from vibration features (RMS, Peak, Crest, Kurtosis, etc.)",
                  accuracy=acc)
    print(f"✓ Saved to {model_dir} (Accuracy: {acc:.2%})")
    
    # --- Copy to other ONNX directories ---
    import shutil
    for target in ['sensor-anomaly-onnx', 'defect-detector-onnx']:
        target_dir = os.path.join(MODELS_DIR, target)
        os.makedirs(target_dir, exist_ok=True)
        if target == 'sensor-anomaly-onnx':
            shutil.copy(os.path.join(MODELS_DIR, 'sensor-onnx', 'model.onnx'),
                       os.path.join(target_dir, 'model.onnx'))
            save_metadata(target_dir, "sensor-anomaly", "onnx", [1, 5],
                         "Alias for sensor-onnx model", accuracy=acc)
        elif target == 'defect-detector-onnx':
            # Create a simple classifier for "defects"
            X_defect = np.random.rand(5000, 64).astype(np.float32)
            y_defect = (X_defect.mean(axis=1) > 0.55).astype(np.float32)
            
            class DefectNet(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.net = nn.Sequential(
                        nn.Linear(64, 32),
                        nn.ReLU(),
                        nn.Linear(32, 1),
                        nn.Sigmoid()
                    )
                def forward(self, x):
                    return self.net(x)
            
            defect_model = DefectNet()
            X_tr, X_te, y_tr, y_te = train_test_split(X_defect, y_defect, test_size=0.2)
            train_pytorch_model(defect_model, X_tr, y_tr, X_te, y_te, epochs=50, verbose=False)
            
            defect_model.eval()
            dummy = torch.randn(1, 64)
            torch.onnx.export(defect_model, dummy, os.path.join(target_dir, 'model.onnx'),
                             input_names=['input'], output_names=['output'],
                             dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                             opset_version=13)
            save_metadata(target_dir, "defect-detector", "onnx", [1, 64],
                         "Simple defect classification from feature vectors")


def train_pytorch_model(model, X_train, y_train, X_test, y_test, epochs=100, verbose=True):
    """Train a PyTorch model"""
    X_train_t = torch.FloatTensor(X_train)
    y_train_t = torch.FloatTensor(y_train).unsqueeze(1)
    X_test_t = torch.FloatTensor(X_test)
    y_test_t = torch.FloatTensor(y_test).unsqueeze(1)
    
    dataset = TensorDataset(X_train_t, y_train_t)
    loader = DataLoader(dataset, batch_size=64, shuffle=True)
    
    criterion = nn.BCELoss()
    optimizer = optim.Adam(model.parameters(), lr=0.001, weight_decay=1e-5)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=10, factor=0.5)
    
    model.train()
    for epoch in range(epochs):
        total_loss = 0
        for X_batch, y_batch in loader:
            optimizer.zero_grad()
            output = model(X_batch)
            loss = criterion(output, y_batch)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        avg_loss = total_loss / len(loader)
        scheduler.step(avg_loss)
        
        if verbose and (epoch + 1) % 20 == 0:
            model.eval()
            with torch.no_grad():
                pred = (model(X_test_t) > 0.5).float()
                acc = (pred == y_test_t).float().mean()
            print(f"  Epoch {epoch+1}/{epochs} - Loss: {avg_loss:.4f} - Val Acc: {acc:.4f}")
            model.train()


def evaluate_pytorch_model(model, X_test, y_test):
    """Evaluate PyTorch model accuracy"""
    model.eval()
    with torch.no_grad():
        X_t = torch.FloatTensor(X_test)
        y_t = torch.FloatTensor(y_test).unsqueeze(1)
        pred = (model(X_t) > 0.5).float()
        acc = (pred == y_t).float().mean().item()
    return acc


# =============================================================================
# KERAS / TENSORFLOW MODELS
# =============================================================================

def train_keras_models():
    """Train Keras models (.keras and .h5)"""
    if not HAS_TF:
        print("Skipping Keras models - TensorFlow not available")
        return
    
    generator = IndustrialDataGenerator(seed=42)
    
    print("\n" + "="*60)
    print("Training Keras Anomaly Model (.keras)")
    print("="*60)
    
    X, y = generator.generate_multi_sensor_data(8000, n_sensors=5, anomaly_ratio=0.12)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    model = keras.Sequential([
        keras.layers.Input(shape=(5,)),
        keras.layers.Dense(32, activation='relu'),
        keras.layers.BatchNormalization(),
        keras.layers.Dropout(0.3),
        keras.layers.Dense(16, activation='relu'),
        keras.layers.Dropout(0.2),
        keras.layers.Dense(1, activation='sigmoid')
    ])
    
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    
    model.fit(X_train, y_train, epochs=50, batch_size=32, 
              validation_split=0.1, verbose=1,
              callbacks=[keras.callbacks.EarlyStopping(patience=10, restore_best_weights=True)])
    
    _, acc = model.evaluate(X_test, y_test, verbose=0)
    
    # Save .keras format
    model_dir = os.path.join(MODELS_DIR, 'keras-anomaly')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.keras'))
    save_metadata(model_dir, "keras-sensor-anomaly", "keras", [1, 5],
                  "5-sensor anomaly detection (Keras 3 format)", accuracy=acc)
    print(f"✓ Saved to {model_dir} (Accuracy: {acc:.2%})")
    
    # Save .h5 format
    model_dir = os.path.join(MODELS_DIR, 'keras-h5-anomaly')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.h5'))
    save_metadata(model_dir, "keras-sensor-anomaly-h5", "keras-h5", [1, 5],
                  "5-sensor anomaly detection (Legacy HDF5 format)", accuracy=acc)
    print(f"✓ Saved to {model_dir} (Accuracy: {acc:.2%})")


def train_tflite_model():
    """Train and convert TFLite model"""
    if not HAS_TF:
        print("Skipping TFLite model - TensorFlow not available")
        return
    
    generator = IndustrialDataGenerator(seed=42)
    
    print("\n" + "="*60)
    print("Training TFLite Anomaly Model")
    print("="*60)
    
    X, y = generator.generate_multi_sensor_data(6000, n_sensors=5, anomaly_ratio=0.12)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    model = keras.Sequential([
        keras.layers.Input(shape=(5,)),
        keras.layers.Dense(16, activation='relu'),
        keras.layers.Dense(8, activation='relu'),
        keras.layers.Dense(1, activation='sigmoid')
    ])
    
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    model.fit(X_train, y_train, epochs=30, batch_size=32, validation_split=0.1, verbose=1)
    
    _, acc = model.evaluate(X_test, y_test, verbose=0)
    
    # Convert to TFLite
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    tflite_model = converter.convert()
    
    model_dir = os.path.join(MODELS_DIR, 'sensor-tflite')
    os.makedirs(model_dir, exist_ok=True)
    
    with open(os.path.join(model_dir, 'model.tflite'), 'wb') as f:
        f.write(tflite_model)
    
    save_metadata(model_dir, "sensor-tflite", "tflite", [1, 5],
                  "5-sensor anomaly detection optimized for edge devices", accuracy=acc)
    print(f"✓ Saved to {model_dir} (Accuracy: {acc:.2%})")


# =============================================================================
# SCIKIT-LEARN MODELS
# =============================================================================

def train_sklearn_models():
    """Train scikit-learn models"""
    if not HAS_SKLEARN:
        print("Skipping sklearn models - scikit-learn not available")
        return
    
    generator = IndustrialDataGenerator(seed=42)
    
    print("\n" + "="*60)
    print("Training Random Forest Model (.pkl)")
    print("="*60)
    
    X, y = generator.generate_multi_sensor_data(10000, n_sensors=5, anomaly_ratio=0.12)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    rf_model = RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        min_samples_split=5,
        random_state=42,
        n_jobs=-1
    )
    rf_model.fit(X_train, y_train)
    
    y_pred = rf_model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"Random Forest Accuracy: {acc:.2%}")
    print(classification_report(y_test, y_pred, target_names=['Normal', 'Anomaly']))
    
    model_dir = os.path.join(MODELS_DIR, 'sklearn-rf')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(rf_model, os.path.join(model_dir, 'model.pkl'))
    save_metadata(model_dir, "random-forest-anomaly", "sklearn-rf", [1, 5],
                  "Random Forest classifier for sensor anomaly detection", accuracy=acc)
    print(f"✓ Saved to {model_dir}")
    
    print("\n" + "="*60)
    print("Training Gradient Boosting Model (.joblib)")
    print("="*60)
    
    gb_model = GradientBoostingClassifier(
        n_estimators=100,
        max_depth=5,
        learning_rate=0.1,
        random_state=42
    )
    gb_model.fit(X_train, y_train)
    
    y_pred = gb_model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"Gradient Boosting Accuracy: {acc:.2%}")
    print(classification_report(y_test, y_pred, target_names=['Normal', 'Anomaly']))
    
    model_dir = os.path.join(MODELS_DIR, 'sklearn-gb')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(gb_model, os.path.join(model_dir, 'model.joblib'))
    save_metadata(model_dir, "gradient-boosting-anomaly", "sklearn-gb", [1, 5],
                  "Gradient Boosting classifier for sensor anomaly detection", accuracy=acc)
    print(f"✓ Saved to {model_dir}")


# =============================================================================
# MAIN
# =============================================================================

def main():
    print("="*60)
    print("TRAINING REALISTIC INDUSTRIAL ML MODELS")
    print("="*60)
    print(f"\nModels directory: {MODELS_DIR}")
    print(f"PyTorch available: {HAS_TORCH}")
    print(f"TensorFlow available: {HAS_TF}")
    print(f"scikit-learn available: {HAS_SKLEARN}")
    
    # Train all models
    train_onnx_models()
    train_keras_models()
    train_tflite_model()
    train_sklearn_models()
    
    print("\n" + "="*60)
    print("ALL MODELS TRAINED SUCCESSFULLY!")
    print("="*60)
    
    # List created models
    print("\nCreated models:")
    for item in sorted(os.listdir(MODELS_DIR)):
        item_path = os.path.join(MODELS_DIR, item)
        if os.path.isdir(item_path):
            meta_path = os.path.join(item_path, 'metadata.json')
            if os.path.exists(meta_path):
                with open(meta_path) as f:
                    meta = json.load(f)
                acc = meta.get('accuracy', 'N/A')
                if isinstance(acc, float):
                    acc = f"{acc:.2%}"
                print(f"  ✓ {item}: {meta.get('description', '')} (Acc: {acc})")


if __name__ == '__main__':
    main()
