#!/usr/bin/env python3
"""
PyTorch Model Training Example for Node-RED Condition Monitoring

This script demonstrates how to:
1. Create a PyTorch neural network
2. Train it on sensor data
3. Export it to ONNX format for use in Node-RED

PyTorch models are exported to ONNX (.onnx) for cross-platform inference.
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

print("="*70)
print("🔥 PyTorch Model Training for Node-RED Condition Monitoring")
print("="*70)
print(f"\nPyTorch Version: {torch.__version__}")
print(f"CUDA Available: {torch.cuda.is_available()}")


# ============================================================
# 1. Define the PyTorch Model Architecture
# ============================================================

class VibrationAnomalyNet(nn.Module):
    """
    Neural Network for Vibration-based Anomaly Detection
    
    This model is designed to detect anomalies in vibration sensor data,
    which is common in industrial condition monitoring for:
    - Bearing failures
    - Rotor imbalance
    - Misalignment
    - Looseness
    
    Input: 8 vibration features (RMS, peak, crest factor, kurtosis, etc.)
    Output: Anomaly probability (0 = normal, 1 = anomaly)
    """
    
    def __init__(self, input_features=8, hidden_sizes=[32, 16, 8]):
        super(VibrationAnomalyNet, self).__init__()
        
        layers = []
        prev_size = input_features
        
        for hidden_size in hidden_sizes:
            layers.extend([
                nn.Linear(prev_size, hidden_size),
                nn.BatchNorm1d(hidden_size),
                nn.ReLU(),
                nn.Dropout(0.2)
            ])
            prev_size = hidden_size
        
        # Output layer
        layers.append(nn.Linear(prev_size, 1))
        layers.append(nn.Sigmoid())
        
        self.network = nn.Sequential(*layers)
    
    def forward(self, x):
        return self.network(x)


# ============================================================
# 2. Generate Training Data
# ============================================================

def generate_vibration_data(n_samples=6000):
    """
    Generate synthetic vibration feature data.
    
    Features (8 total):
    1. RMS (Root Mean Square) - overall vibration level
    2. Peak - maximum amplitude
    3. Crest Factor - peak/RMS ratio
    4. Kurtosis - peakedness of distribution
    5. Skewness - asymmetry of distribution
    6. Dominant Frequency - main frequency component (normalized)
    7. Spectral Centroid - center of mass of spectrum
    8. Band Energy Ratio - high freq / low freq energy
    
    Anomaly types:
    - Bearing fault: High kurtosis, crest factor
    - Imbalance: High RMS at low frequency
    - Looseness: Broadband vibration, high crest factor
    - Misalignment: High harmonics
    """
    np.random.seed(42)
    
    # Normal operating conditions (85%)
    n_normal = int(n_samples * 0.85)
    normal_data = np.random.normal(
        loc=[0.3, 0.5, 3.0, 3.0, 0.0, 0.25, 0.4, 1.0],  # typical normal values
        scale=[0.05, 0.08, 0.3, 0.3, 0.1, 0.05, 0.08, 0.15],
        size=(n_normal, 8)
    )
    normal_labels = np.zeros(n_normal)
    
    # Anomaly data (15%)
    n_anomaly = n_samples - n_normal
    anomaly_data = []
    
    for _ in range(n_anomaly):
        fault_type = np.random.choice(['bearing', 'imbalance', 'looseness', 'misalignment'])
        
        if fault_type == 'bearing':
            # Bearing fault: High kurtosis and crest factor, spiky vibration
            features = np.random.normal(
                loc=[0.4, 0.9, 5.5, 7.0, 0.5, 0.6, 0.7, 2.5],
                scale=[0.08, 0.1, 0.5, 1.0, 0.2, 0.1, 0.1, 0.3]
            )
        elif fault_type == 'imbalance':
            # Imbalance: High RMS, strong 1x component
            features = np.random.normal(
                loc=[0.7, 1.0, 3.2, 3.5, 0.1, 0.1, 0.2, 0.5],
                scale=[0.1, 0.15, 0.3, 0.4, 0.1, 0.03, 0.05, 0.1]
            )
        elif fault_type == 'looseness':
            # Looseness: Broadband, high crest factor, multiple harmonics
            features = np.random.normal(
                loc=[0.5, 0.85, 5.0, 4.5, 0.3, 0.5, 0.6, 2.0],
                scale=[0.1, 0.1, 0.4, 0.5, 0.15, 0.1, 0.1, 0.25]
            )
        else:  # misalignment
            # Misalignment: Moderate RMS, strong 2x component
            features = np.random.normal(
                loc=[0.55, 0.75, 3.8, 4.0, 0.2, 0.2, 0.35, 1.5],
                scale=[0.08, 0.1, 0.35, 0.4, 0.1, 0.05, 0.08, 0.2]
            )
        
        # Clip to reasonable ranges
        features = np.clip(features, 0, 10)
        anomaly_data.append(features)
    
    anomaly_data = np.array(anomaly_data)
    anomaly_labels = np.ones(n_anomaly)
    
    # Combine and normalize
    X = np.vstack([normal_data, anomaly_data]).astype(np.float32)
    y = np.hstack([normal_labels, anomaly_labels]).astype(np.float32)
    
    # Normalize features to 0-1 range
    X_min = X.min(axis=0)
    X_max = X.max(axis=0)
    X_normalized = (X - X_min) / (X_max - X_min + 1e-8)
    
    # Shuffle
    indices = np.random.permutation(len(X_normalized))
    
    return X_normalized[indices], y[indices], X_min, X_max


# ============================================================
# 3. Train the Model
# ============================================================

def train_model():
    """Train the PyTorch model."""
    
    print("\n" + "-"*50)
    print("📊 Generating Training Data")
    print("-"*50)
    
    X, y, X_min, X_max = generate_vibration_data(n_samples=8000)
    
    # Split into train/test
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"Training samples: {len(X_train)}")
    print(f"Test samples: {len(X_test)}")
    print(f"Features: 8 (vibration characteristics)")
    print(f"Anomaly ratio: {y.mean():.1%}")
    
    # Create DataLoaders
    train_dataset = TensorDataset(
        torch.FloatTensor(X_train),
        torch.FloatTensor(y_train).unsqueeze(1)
    )
    test_dataset = TensorDataset(
        torch.FloatTensor(X_test),
        torch.FloatTensor(y_test).unsqueeze(1)
    )
    
    train_loader = DataLoader(train_dataset, batch_size=64, shuffle=True)
    test_loader = DataLoader(test_dataset, batch_size=64, shuffle=False)
    
    print("\n" + "-"*50)
    print("🏗️  Building PyTorch Model")
    print("-"*50)
    
    # Create model
    model = VibrationAnomalyNet(input_features=8, hidden_sizes=[32, 16, 8])
    print(model)
    
    # Count parameters
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"\nTotal parameters: {total_params:,}")
    print(f"Trainable parameters: {trainable_params:,}")
    
    # Loss and optimizer
    criterion = nn.BCELoss()
    optimizer = optim.Adam(model.parameters(), lr=0.001, weight_decay=1e-5)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=3, factor=0.5)
    
    print("\n" + "-"*50)
    print("🚀 Training")
    print("-"*50)
    
    n_epochs = 50
    best_val_loss = float('inf')
    patience = 7
    patience_counter = 0
    best_model_state = None
    
    for epoch in range(n_epochs):
        # Training
        model.train()
        train_loss = 0.0
        train_correct = 0
        train_total = 0
        
        for batch_X, batch_y in train_loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            
            train_loss += loss.item()
            predicted = (outputs > 0.5).float()
            train_total += batch_y.size(0)
            train_correct += (predicted == batch_y).sum().item()
        
        train_loss /= len(train_loader)
        train_acc = train_correct / train_total
        
        # Validation
        model.eval()
        val_loss = 0.0
        val_correct = 0
        val_total = 0
        
        with torch.no_grad():
            for batch_X, batch_y in test_loader:
                outputs = model(batch_X)
                loss = criterion(outputs, batch_y)
                val_loss += loss.item()
                predicted = (outputs > 0.5).float()
                val_total += batch_y.size(0)
                val_correct += (predicted == batch_y).sum().item()
        
        val_loss /= len(test_loader)
        val_acc = val_correct / val_total
        
        scheduler.step(val_loss)
        
        # Print progress
        if (epoch + 1) % 5 == 0 or epoch == 0:
            print(f"Epoch {epoch+1:3d}/{n_epochs} | "
                  f"Train Loss: {train_loss:.4f}, Acc: {train_acc:.4f} | "
                  f"Val Loss: {val_loss:.4f}, Acc: {val_acc:.4f}")
        
        # Early stopping
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            best_model_state = model.state_dict().copy()
        else:
            patience_counter += 1
            if patience_counter >= patience:
                print(f"\n⏹️  Early stopping at epoch {epoch+1}")
                break
    
    # Load best model
    model.load_state_dict(best_model_state)
    
    # Final evaluation
    print("\n" + "-"*50)
    print("📈 Final Evaluation")
    print("-"*50)
    
    model.eval()
    test_correct = 0
    test_total = 0
    all_preds = []
    all_labels = []
    
    with torch.no_grad():
        for batch_X, batch_y in test_loader:
            outputs = model(batch_X)
            predicted = (outputs > 0.5).float()
            test_total += batch_y.size(0)
            test_correct += (predicted == batch_y).sum().item()
            all_preds.extend(predicted.squeeze().numpy())
            all_labels.extend(batch_y.squeeze().numpy())
    
    test_acc = test_correct / test_total
    print(f"Test Accuracy: {test_acc:.4f} ({test_correct}/{test_total})")
    
    # Calculate precision, recall, F1
    all_preds = np.array(all_preds)
    all_labels = np.array(all_labels)
    
    tp = ((all_preds == 1) & (all_labels == 1)).sum()
    fp = ((all_preds == 1) & (all_labels == 0)).sum()
    fn = ((all_preds == 0) & (all_labels == 1)).sum()
    
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    
    print(f"Precision: {precision:.4f}")
    print(f"Recall: {recall:.4f}")
    print(f"F1 Score: {f1:.4f}")
    
    return model, X_min, X_max, test_acc


# ============================================================
# 4. Export to ONNX
# ============================================================

def export_to_onnx(model, X_min, X_max, accuracy):
    """Export PyTorch model to ONNX format."""
    
    print("\n" + "-"*50)
    print("📦 Exporting to ONNX")
    print("-"*50)
    
    output_dir = os.path.join(MODELS_DIR, 'pytorch-vibration')
    os.makedirs(output_dir, exist_ok=True)
    
    model.eval()
    
    # Create dummy input
    dummy_input = torch.randn(1, 8)
    
    # Export to ONNX
    onnx_path = os.path.join(output_dir, 'model.onnx')
    
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        export_params=True,
        opset_version=13,
        do_constant_folding=True,
        input_names=['vibration_features'],
        output_names=['anomaly_probability'],
        dynamic_axes={
            'vibration_features': {0: 'batch_size'},
            'anomaly_probability': {0: 'batch_size'}
        }
    )
    
    print(f"✓ ONNX model saved: {onnx_path}")
    print(f"  File size: {os.path.getsize(onnx_path):,} bytes")
    
    # Save metadata
    metadata = {
        'model_name': 'VibrationAnomalyNet',
        'framework': 'PyTorch',
        'pytorch_version': torch.__version__,
        'format': 'onnx',
        'file': 'model.onnx',
        'input_shape': [8],
        'input_name': 'vibration_features',
        'output_name': 'anomaly_probability',
        'features': [
            'rms',
            'peak',
            'crest_factor',
            'kurtosis',
            'skewness',
            'dominant_frequency',
            'spectral_centroid',
            'band_energy_ratio'
        ],
        'feature_normalization': {
            'min': X_min.tolist(),
            'max': X_max.tolist()
        },
        'threshold': 0.5,
        'accuracy': float(accuracy),
        'description': 'Vibration-based anomaly detection for bearing, imbalance, looseness, and misalignment faults',
        'use_cases': [
            'Bearing fault detection',
            'Rotor imbalance detection',
            'Mechanical looseness detection',
            'Shaft misalignment detection'
        ]
    }
    
    metadata_path = os.path.join(output_dir, 'metadata.json')
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    
    print(f"✓ Metadata saved: {metadata_path}")
    
    # Verify ONNX model
    try:
        import onnx
        onnx_model = onnx.load(onnx_path)
        onnx.checker.check_model(onnx_model)
        print("✓ ONNX model validation passed!")
    except ImportError:
        print("⚠️ onnx package not installed, skipping validation")
    except Exception as e:
        print(f"⚠️ ONNX validation warning: {e}")
    
    return onnx_path


# ============================================================
# 5. Main
# ============================================================

if __name__ == '__main__':
    # Set random seeds for reproducibility
    torch.manual_seed(42)
    np.random.seed(42)
    
    # Train model
    model, X_min, X_max, accuracy = train_model()
    
    # Export to ONNX
    onnx_path = export_to_onnx(model, X_min, X_max, accuracy)
    
    print("\n" + "="*70)
    print("✅ PyTorch Model Training Complete!")
    print("="*70)
    
    print("""
📋 Usage in Node-RED:

1. Configure ML Inference node:
   - Model Type: ONNX
   - Model Path: /data/models/pytorch-vibration/model.onnx

2. Input format (8 normalized vibration features):
   msg.payload = [rms, peak, crest_factor, kurtosis, skewness, 
                  dominant_freq, spectral_centroid, band_energy_ratio];

3. Example input (normal):
   msg.payload = [0.3, 0.4, 0.5, 0.3, 0.5, 0.25, 0.4, 0.5];

4. Example input (bearing fault):
   msg.payload = [0.5, 0.9, 0.8, 0.9, 0.7, 0.7, 0.8, 0.9];

5. Output interpretation:
   - prediction < 0.5 → Normal operation
   - prediction >= 0.5 → Anomaly detected
""")
