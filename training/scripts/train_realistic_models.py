#!/usr/bin/env python3
"""
Train ML Models with REALISTIC Synthetic Industrial Data

Key improvements over previous version:
1. OVERLAPPING DISTRIBUTIONS - Normal and anomaly data overlap (realistic!)
2. SMOTE/ADASYN RESAMPLING - Handle class imbalance properly
3. CORRELATED ANOMALIES - Multi-sensor failure patterns

Expected results:
- Accuracy: 75-85% (NOT 99%!)
- Normal output: 0.15-0.30 anomaly score
- Borderline: 0.40-0.60
- Clear anomaly: 0.70-0.90
- ROC-AUC: 0.80-0.88
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
    from sklearn.ensemble import (RandomForestClassifier, GradientBoostingClassifier,
                                  IsolationForest, RandomForestRegressor, GradientBoostingRegressor)
    from sklearn.svm import OneClassSVM
    from sklearn.preprocessing import StandardScaler, LabelEncoder
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import (classification_report, accuracy_score, roc_auc_score,
                                 mean_squared_error, mean_absolute_error, r2_score)
    import joblib
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False
    print("Warning: scikit-learn not available, skipping sklearn models")

# SMOTE/ADASYN support
try:
    from imblearn.over_sampling import SMOTE, ADASYN
    from imblearn.combine import SMOTETomek
    HAS_IMBLEARN = True
except ImportError:
    HAS_IMBLEARN = False
    print("Warning: imbalanced-learn not available, skipping resampling")

# XGBoost support
try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except ImportError:
    HAS_XGBOOST = False
    print("Warning: XGBoost not available, skipping XGBoost models")

# Paths - auto-detect Docker vs local environment
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(os.path.dirname(SCRIPT_DIR))

# Check if running in Docker (look for /data/models)
if os.path.exists('/data/models'):
    MODELS_DIR = '/data/models'
else:
    MODELS_DIR = os.path.join(PROJECT_DIR, 'models')

# Environment configuration
SMOTE_ENABLED = os.environ.get('SMOTE_ENABLED', 'true').lower() == 'true'
OVERLAP_RATIO = float(os.environ.get('OVERLAP_RATIO', '0.55'))  # More borderline cases
IMBALANCE_RATIO = float(os.environ.get('IMBALANCE_RATIO', '0.25'))  # More anomalies
LABEL_NOISE_RATIO = float(os.environ.get('LABEL_NOISE_RATIO', '0.08'))  # 8% label noise
FEATURE_NOISE_STD = float(os.environ.get('FEATURE_NOISE_STD', '0.05'))  # Extra feature noise

# Ensure models directory exists
os.makedirs(MODELS_DIR, exist_ok=True)


# =============================================================================
# SMOTE/ADASYN RESAMPLING
# =============================================================================

def apply_resampling(X_train, y_train, method='smote'):
    """
    Apply resampling to handle class imbalance.

    Args:
        X_train: Training features
        y_train: Training labels
        method: 'smote', 'adasyn', or 'smotetomek'

    Returns:
        X_resampled, y_resampled
    """
    if not HAS_IMBLEARN or not SMOTE_ENABLED:
        print("  Skipping resampling (disabled or imblearn not available)")
        return X_train, y_train

    n_minority = int(y_train.sum())
    n_majority = len(y_train) - n_minority

    if n_minority < 6:  # Need at least 6 samples for k_neighbors=5
        print(f"  Skipping resampling: only {n_minority} minority samples")
        return X_train, y_train

    print(f"  Applying {method.upper()} resampling...")
    print(f"    Before: {n_majority} normal, {n_minority} anomaly")

    try:
        if method == 'smote':
            sampler = SMOTE(random_state=42, k_neighbors=min(5, n_minority - 1))
        elif method == 'adasyn':
            sampler = ADASYN(random_state=42, n_neighbors=min(5, n_minority - 1))
        elif method == 'smotetomek':
            sampler = SMOTETomek(random_state=42)
        else:
            return X_train, y_train

        X_res, y_res = sampler.fit_resample(X_train, y_train)

        n_minority_new = int(y_res.sum())
        n_majority_new = len(y_res) - n_minority_new
        print(f"    After: {n_majority_new} normal, {n_minority_new} anomaly")

        return X_res.astype(np.float32), y_res.astype(np.float32)
    except Exception as e:
        print(f"  Resampling failed: {e}")
        return X_train, y_train


def add_label_noise(y, noise_ratio=None):
    """
    Add label noise by randomly flipping some labels.
    This prevents overfitting and creates more realistic uncertainty.
    """
    if noise_ratio is None:
        noise_ratio = LABEL_NOISE_RATIO
    if noise_ratio <= 0:
        return y

    y_noisy = y.copy()
    n_flip = int(len(y) * noise_ratio)
    flip_indices = np.random.choice(len(y), n_flip, replace=False)
    y_noisy[flip_indices] = 1 - y_noisy[flip_indices]
    print(f"  Added label noise: {n_flip} labels flipped ({noise_ratio*100:.1f}%)")
    return y_noisy


def add_feature_noise(X, noise_std=None):
    """
    Add Gaussian noise to features to increase uncertainty.
    """
    if noise_std is None:
        noise_std = FEATURE_NOISE_STD
    if noise_std <= 0:
        return X

    noise = np.random.normal(0, noise_std, X.shape)
    X_noisy = np.clip(X + noise, 0, 1)
    print(f"  Added feature noise: std={noise_std}")
    return X_noisy.astype(np.float32)


# =============================================================================
# REALISTIC DATA GENERATORS WITH OVERLAPPING DISTRIBUTIONS
# =============================================================================

class RealisticIndustrialDataGenerator:
    """
    Generate REALISTIC industrial sensor data with:
    - Overlapping distributions (no perfect separation!)
    - Borderline cases (hard to classify)
    - Correlated multi-sensor anomalies
    """

    def __init__(self, seed=42, overlap_ratio=0.3):
        np.random.seed(seed)
        self.overlap_ratio = overlap_ratio  # Fraction of borderline cases

    def generate_temperature_sensor(self, n_samples, anomaly_ratio=0.15):
        """
        REALISTIC temperature sensor with OVERLAPPING distributions.

        Normal: Gaussian around 70C (std=5) -> range ~55-85C
        Anomaly: Mix of:
          - Borderline (78C, std=4) -> overlaps with normal!
          - Moderate (88C, std=5)
          - Severe (98C, std=4)
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        # Normal: 70C +/- 5C (covers ~55-85C)
        normal_temps = np.random.normal(70, 5, n_normal)

        # Anomalies with overlapping zones
        n_borderline = int(n_anomaly * self.overlap_ratio)
        n_moderate = int(n_anomaly * 0.4)
        n_severe = n_anomaly - n_borderline - n_moderate

        anomaly_temps = np.concatenate([
            np.random.normal(78, 4, n_borderline),   # Borderline: 70-86C (overlaps!)
            np.random.normal(88, 5, n_moderate),     # Moderate: 78-98C
            np.random.normal(98, 4, n_severe)        # Severe: 90-106C
        ])

        # Normalize to 0-1 range (based on realistic bounds 40-120C)
        all_temps = np.concatenate([normal_temps, anomaly_temps])
        all_temps = np.clip(all_temps, 40, 120)
        all_temps_norm = (all_temps - 40) / 80  # 40-120C -> 0-1

        labels = np.concatenate([
            np.zeros(n_normal),
            np.ones(n_anomaly)
        ])

        return all_temps_norm.astype(np.float32), labels.astype(np.float32)

    def generate_vibration_sensor(self, n_samples, anomaly_ratio=0.15):
        """
        REALISTIC vibration sensor (mm/s RMS) with overlapping distributions.

        Normal: 1.5-3.0 mm/s (ISO 10816 Zone A/B)
        Anomaly:
          - Borderline: 3.5-5.0 mm/s (Zone C - just alarming)
          - Moderate: 5.0-8.0 mm/s (Zone D - unacceptable)
          - Severe: 8.0-15.0 mm/s (dangerous)
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        # Normal vibration
        normal_vib = np.random.normal(2.2, 0.5, n_normal)
        normal_vib = np.clip(normal_vib, 1.0, 4.0)

        # Anomaly vibration (overlapping!)
        n_borderline = int(n_anomaly * self.overlap_ratio)
        n_moderate = int(n_anomaly * 0.4)
        n_severe = n_anomaly - n_borderline - n_moderate

        anomaly_vib = np.concatenate([
            np.random.normal(4.2, 0.8, n_borderline),  # Borderline: 2.6-5.8 (overlaps!)
            np.random.normal(6.5, 1.2, n_moderate),    # Moderate: 4.1-8.9
            np.random.normal(11, 2, n_severe)          # Severe: 7-15
        ])
        anomaly_vib = np.clip(anomaly_vib, 2.5, 20)

        all_vib = np.concatenate([normal_vib, anomaly_vib])
        # Normalize: 0-20 mm/s -> 0-1
        all_vib_norm = all_vib / 20

        labels = np.concatenate([np.zeros(n_normal), np.ones(n_anomaly)])

        return all_vib_norm.astype(np.float32), labels.astype(np.float32)

    def generate_pressure_sensor(self, n_samples, anomaly_ratio=0.15):
        """
        REALISTIC pressure sensor with overlapping distributions.

        Normal: 5 bar +/- 0.3 bar
        Anomaly:
          - Borderline low: 4.2-4.6 bar (slight leak)
          - Moderate low: 3.0-4.0 bar (leak)
          - Severe high: 7-9 bar (blockage)
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        normal_press = np.random.normal(5.0, 0.3, n_normal)
        normal_press = np.clip(normal_press, 4.0, 6.0)

        n_borderline = int(n_anomaly * self.overlap_ratio)
        n_moderate = int(n_anomaly * 0.35)
        n_severe = n_anomaly - n_borderline - n_moderate

        anomaly_press = np.concatenate([
            np.random.normal(4.4, 0.2, n_borderline),  # Borderline: 4.0-4.8 (overlaps!)
            np.random.normal(3.5, 0.4, n_moderate),    # Low: 2.7-4.3
            np.random.normal(8.0, 0.8, n_severe)       # High: 6.4-9.6
        ])
        anomaly_press = np.clip(anomaly_press, 1, 12)

        all_press = np.concatenate([normal_press, anomaly_press])
        # Normalize: 0-12 bar -> 0-1
        all_press_norm = all_press / 12

        labels = np.concatenate([np.zeros(n_normal), np.ones(n_anomaly)])

        return all_press_norm.astype(np.float32), labels.astype(np.float32)

    def generate_current_sensor(self, n_samples, anomaly_ratio=0.15):
        """
        REALISTIC motor current sensor with overlapping distributions.

        Normal: 17.5A +/- 1A
        Anomaly:
          - Borderline: 20-22A (high load)
          - Overload: 24-30A
          - Short: 35-50A
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        normal_current = np.random.normal(17.5, 1.0, n_normal)
        normal_current = np.clip(normal_current, 14, 21)

        n_borderline = int(n_anomaly * self.overlap_ratio)
        n_overload = int(n_anomaly * 0.4)
        n_short = n_anomaly - n_borderline - n_overload

        anomaly_current = np.concatenate([
            np.random.normal(21, 1.5, n_borderline),   # Borderline: 18-24 (overlaps!)
            np.random.normal(27, 2, n_overload),       # Overload: 23-31
            np.random.normal(42, 5, n_short)           # Short: 32-52
        ])
        anomaly_current = np.clip(anomaly_current, 18, 60)

        all_current = np.concatenate([normal_current, anomaly_current])
        # Normalize: 0-60A -> 0-1
        all_current_norm = all_current / 60

        labels = np.concatenate([np.zeros(n_normal), np.ones(n_anomaly)])

        return all_current_norm.astype(np.float32), labels.astype(np.float32)

    def generate_flow_sensor(self, n_samples, anomaly_ratio=0.15):
        """
        REALISTIC flow sensor with overlapping distributions.
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        normal_flow = np.random.normal(100, 5, n_normal)
        normal_flow = np.clip(normal_flow, 85, 115)

        n_borderline = int(n_anomaly * self.overlap_ratio)
        n_low = int(n_anomaly * 0.35)
        n_high = n_anomaly - n_borderline - n_low

        anomaly_flow = np.concatenate([
            np.random.normal(82, 5, n_borderline),   # Borderline: 72-92 (overlaps!)
            np.random.normal(55, 10, n_low),          # Low: 35-75
            np.random.normal(135, 10, n_high)         # High: 115-155
        ])
        anomaly_flow = np.clip(anomaly_flow, 20, 160)

        all_flow = np.concatenate([normal_flow, anomaly_flow])
        # Normalize: 0-160 L/min -> 0-1
        all_flow_norm = all_flow / 160

        labels = np.concatenate([np.zeros(n_normal), np.ones(n_anomaly)])

        return all_flow_norm.astype(np.float32), labels.astype(np.float32)

    def generate_8sensor_motor_data(self, n_samples, anomaly_ratio=0.15):
        """
        Generate REALISTIC 8-sensor motor/pump data with CORRELATED anomalies.

        Sensors: temp, vibration, pressure, power, speed, flow, current, humidity

        CORRELATED failure patterns:
        - Bearing failure: temp+, vibration++, current+
        - Motor overload: temp++, current++, power++, speed-
        - Pump cavitation: pressure--, vibration+, flow-

        Returns normalized values (0-1) with realistic overlapping distributions.
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        # Split anomaly types
        n_bearing = n_anomaly // 3
        n_overload = n_anomaly // 3
        n_cavitation = n_anomaly - n_bearing - n_overload

        features = []
        labels = []

        # --- NORMAL SAMPLES (with natural variation) ---
        for _ in range(n_normal):
            sample = [
                np.random.normal(0.45, 0.04),   # temp: 0.37-0.53
                np.random.normal(0.25, 0.05),   # vibration: 0.15-0.35
                np.random.normal(0.55, 0.04),   # pressure: 0.47-0.63
                np.random.normal(0.50, 0.04),   # power: 0.42-0.58
                np.random.normal(0.60, 0.03),   # speed: 0.54-0.66
                np.random.normal(0.55, 0.04),   # flow: 0.47-0.63
                np.random.normal(0.45, 0.04),   # current: 0.37-0.53
                np.random.normal(0.40, 0.05),   # humidity: 0.30-0.50
            ]
            features.append(np.clip(sample, 0, 1))
            labels.append(0)

        # --- BORDERLINE CASES (VERY hard to classify - overlaps with normal!) ---
        n_borderline = int(n_anomaly * self.overlap_ratio)
        for _ in range(n_borderline):
            # Almost identical to normal with very slight variations
            # These should produce scores around 0.4-0.6
            sample = [
                np.random.normal(0.48, 0.06),   # temp: barely above normal (0.42-0.54)
                np.random.normal(0.30, 0.07),   # vibration: slightly high (0.23-0.37)
                np.random.normal(0.52, 0.06),   # pressure: normal-ish (0.46-0.58)
                np.random.normal(0.53, 0.06),   # power: barely elevated (0.47-0.59)
                np.random.normal(0.57, 0.05),   # speed: almost normal (0.52-0.62)
                np.random.normal(0.52, 0.06),   # flow: slightly low (0.46-0.58)
                np.random.normal(0.48, 0.06),   # current: barely elevated (0.42-0.54)
                np.random.normal(0.41, 0.05),   # humidity: normal (0.36-0.46)
            ]
            features.append(np.clip(sample, 0, 1))
            labels.append(1)

        remaining_anomalies = n_anomaly - n_borderline
        n_bearing = remaining_anomalies // 3
        n_overload = remaining_anomalies // 3
        n_cavitation = remaining_anomalies - n_bearing - n_overload

        # --- BEARING FAILURE (temp+, vibration++, current+) ---
        for _ in range(n_bearing):
            sample = [
                np.random.normal(0.70, 0.08),   # temp: elevated (0.62-0.78)
                np.random.normal(0.80, 0.10),   # vibration: HIGH (0.70-0.90)
                np.random.normal(0.55, 0.05),   # pressure: normal
                np.random.normal(0.55, 0.05),   # power: slightly up
                np.random.normal(0.58, 0.05),   # speed: normal
                np.random.normal(0.53, 0.05),   # flow: normal
                np.random.normal(0.60, 0.08),   # current: elevated
                np.random.normal(0.40, 0.05),   # humidity: normal
            ]
            features.append(np.clip(sample, 0, 1))
            labels.append(1)

        # --- MOTOR OVERLOAD (temp++, current++, power++, speed-) ---
        for _ in range(n_overload):
            sample = [
                np.random.normal(0.78, 0.08),   # temp: HIGH (0.70-0.86)
                np.random.normal(0.42, 0.08),   # vibration: slightly elevated
                np.random.normal(0.50, 0.05),   # pressure: normal
                np.random.normal(0.85, 0.08),   # power: HIGH (0.77-0.93)
                np.random.normal(0.32, 0.08),   # speed: LOW (0.24-0.40)
                np.random.normal(0.45, 0.06),   # flow: reduced
                np.random.normal(0.85, 0.08),   # current: HIGH (0.77-0.93)
                np.random.normal(0.40, 0.05),   # humidity: normal
            ]
            features.append(np.clip(sample, 0, 1))
            labels.append(1)

        # --- PUMP CAVITATION (pressure--, vibration+, flow-) ---
        for _ in range(n_cavitation):
            sample = [
                np.random.normal(0.60, 0.08),   # temp: slightly elevated
                np.random.normal(0.72, 0.10),   # vibration: HIGH (0.62-0.82)
                np.random.normal(0.15, 0.06),   # pressure: LOW (0.09-0.21)
                np.random.normal(0.55, 0.05),   # power: normal
                np.random.normal(0.58, 0.05),   # speed: normal
                np.random.normal(0.28, 0.08),   # flow: LOW (0.20-0.36)
                np.random.normal(0.50, 0.06),   # current: normal
                np.random.normal(0.40, 0.05),   # humidity: normal
            ]
            features.append(np.clip(sample, 0, 1))
            labels.append(1)

        # Shuffle
        X = np.array(features, dtype=np.float32)
        y = np.array(labels, dtype=np.float32)

        indices = np.random.permutation(len(X))
        return X[indices], y[indices]

    def generate_multi_sensor_data(self, n_samples, n_sensors=5, anomaly_ratio=0.15):
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
            data.append(values)
            all_labels.append(labels)

        X = np.column_stack(data).astype(np.float32)
        # Label as anomaly if ANY sensor shows anomaly
        y = np.max(np.column_stack(all_labels), axis=1).astype(np.float32)

        # Shuffle
        indices = np.random.permutation(len(X))
        return X[indices], y[indices]

    def generate_vibration_features(self, n_samples, anomaly_ratio=0.15):
        """
        Generate REALISTIC vibration feature data for bearing analysis
        with overlapping distributions.
        """
        n_normal = int(n_samples * (1 - anomaly_ratio))
        n_anomaly = n_samples - n_normal

        features = []
        labels = []

        # Normal bearings
        for _ in range(n_normal):
            f = [
                np.random.normal(2.2, 0.5),    # RMS: 1.2-3.2 mm/s
                np.random.normal(5.5, 1.5),    # Peak: 2.5-8.5 mm/s
                np.random.normal(3.2, 0.4),    # Crest Factor: 2.4-4.0
                np.random.normal(3.0, 0.3),    # Kurtosis: ~3 (Gaussian)
                np.random.normal(0, 0.2),      # Skewness: ~0
                np.random.normal(40, 15),      # Dominant Freq: 10-70 Hz
                np.random.normal(150, 30),     # Spectral Centroid: 90-210 Hz
                np.random.normal(0.4, 0.08),   # Band Energy: 0.24-0.56
            ]
            features.append(f)
            labels.append(0)

        # Borderline cases (early stage faults)
        n_borderline = int(n_anomaly * self.overlap_ratio)
        for _ in range(n_borderline):
            f = [
                np.random.normal(3.5, 0.6),    # RMS slightly elevated
                np.random.normal(9, 2),        # Peak elevated
                np.random.normal(3.8, 0.5),    # Crest Factor slightly up
                np.random.normal(3.8, 0.5),    # Kurtosis slightly up
                np.random.normal(0.3, 0.2),    # Skewness slightly up
                np.random.normal(70, 20),      # Freq shifted
                np.random.normal(200, 40),     # Centroid shifted
                np.random.normal(0.52, 0.08),  # Band Energy up
            ]
            features.append(f)
            labels.append(1)

        # Clear faults
        remaining = n_anomaly - n_borderline
        for _ in range(remaining):
            fault = np.random.choice(['inner', 'outer', 'ball', 'cage'])

            if fault == 'inner':
                f = [
                    np.random.normal(8, 2),        # RMS high
                    np.random.normal(25, 6),       # Peak very high
                    np.random.normal(5.5, 1),      # Crest Factor high
                    np.random.normal(8, 2),        # Kurtosis very high
                    np.random.normal(1.2, 0.5),    # Skewness high
                    np.random.normal(120, 25),     # Freq high
                    np.random.normal(320, 50),     # Centroid high
                    np.random.normal(0.72, 0.1),   # Band Energy high
                ]
            elif fault == 'outer':
                f = [
                    np.random.normal(6, 1.5),
                    np.random.normal(18, 5),
                    np.random.normal(5, 0.8),
                    np.random.normal(6, 1.5),
                    np.random.normal(0.8, 0.4),
                    np.random.normal(90, 20),
                    np.random.normal(270, 40),
                    np.random.normal(0.65, 0.1),
                ]
            elif fault == 'ball':
                f = [
                    np.random.normal(5, 1.2),
                    np.random.normal(14, 4),
                    np.random.normal(4.5, 0.7),
                    np.random.normal(4.5, 1),
                    np.random.normal(0.5, 0.3),
                    np.random.normal(150, 35),
                    np.random.normal(240, 40),
                    np.random.normal(0.60, 0.1),
                ]
            else:  # cage
                f = [
                    np.random.normal(4.5, 1),
                    np.random.normal(12, 3),
                    np.random.normal(4, 0.6),
                    np.random.normal(4, 0.8),
                    np.random.normal(0.4, 0.25),
                    np.random.normal(25, 10),
                    np.random.normal(200, 35),
                    np.random.normal(0.55, 0.1),
                ]

            features.append(f)
            labels.append(1)

        X = np.array(features, dtype=np.float32)
        y = np.array(labels, dtype=np.float32)

        # Normalize each feature to 0-1
        for j in range(X.shape[1]):
            X[:, j] = (X[:, j] - X[:, j].min()) / (X[:, j].max() - X[:, j].min() + 1e-8)

        # Shuffle
        indices = np.random.permutation(len(X))
        return X[indices], y[indices]


def save_metadata(model_dir, model_name, model_type, input_shape, description,
                  accuracy=None, roc_auc=None, realistic=True):
    """Save model metadata"""
    metadata = {
        "name": model_name,
        "version": "3.0.0",
        "type": model_type,
        "description": description,
        "inputShape": input_shape,
        "trainedOn": "Realistic synthetic data with overlapping distributions",
        "createdAt": datetime.now().isoformat(),
        "framework": model_type.split('-')[0] if '-' in model_type else model_type,
        "realisticTraining": realistic,
        "expectedAccuracy": "75-85% (realistic, not overfit)",
    }
    if accuracy is not None:
        metadata["accuracy"] = float(accuracy)
    if roc_auc is not None:
        metadata["rocAuc"] = float(roc_auc)

    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)


def save_scaler(model_dir, X_train):
    """Save StandardScaler for inference normalization"""
    if HAS_SKLEARN:
        scaler = StandardScaler()
        scaler.fit(X_train)

        # Save as JSON for JavaScript inference
        scaler_data = {
            "mean": scaler.mean_.tolist(),
            "scale": scaler.scale_.tolist(),
            "var": scaler.var_.tolist()
        }
        with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
            json.dump(scaler_data, f, indent=2)

        return scaler
    return None


# =============================================================================
# PYTORCH / ONNX MODELS
# =============================================================================

def train_onnx_models():
    """Train all ONNX models using PyTorch"""
    if not HAS_TORCH:
        print("Skipping ONNX models - PyTorch not available")
        return

    generator = RealisticIndustrialDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)

    # --- 5-Sensor Anomaly Model ---
    print("\n" + "="*60)
    print("Training 5-Sensor Anomaly Model (ONNX) - REALISTIC")
    print("="*60)

    X, y = generator.generate_multi_sensor_data(10000, n_sensors=5, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Apply SMOTE, then add noise for realistic uncertainty
    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')
    X_train_res = add_feature_noise(X_train_res)
    y_train_res = add_label_noise(y_train_res)

    class SensorNet(nn.Module):
        def __init__(self, n_features):
            super().__init__()
            # Smaller, regularized network for realistic uncertainty
            self.net = nn.Sequential(
                nn.Linear(n_features, 16),
                nn.ReLU(),
                nn.Dropout(0.4),
                nn.Linear(16, 8),
                nn.ReLU(),
                nn.Dropout(0.3),
                nn.Linear(8, 1),
                nn.Sigmoid()
            )
        def forward(self, x):
            return self.net(x)

    model = SensorNet(5)
    train_pytorch_model(model, X_train_res, y_train_res, X_test, y_test, epochs=100)

    # Export to ONNX
    model_dir = os.path.join(MODELS_DIR, 'sensor-onnx')
    os.makedirs(model_dir, exist_ok=True)

    model.eval()
    dummy = torch.randn(1, 5)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=18)

    acc, roc = evaluate_pytorch_model(model, X_test, y_test)
    save_metadata(model_dir, "sensor-anomaly-5", "onnx", [1, 5],
                  "5-sensor industrial anomaly detection (temp, pressure, vibration, flow, current)",
                  accuracy=acc, roc_auc=roc)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")

    # --- 10-Sensor Model ---
    print("\n" + "="*60)
    print("Training 10-Sensor Anomaly Model (ONNX) - REALISTIC")
    print("="*60)

    X, y = generator.generate_multi_sensor_data(15000, n_sensors=10, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')
    X_train_res = add_feature_noise(X_train_res)
    y_train_res = add_label_noise(y_train_res)

    model = SensorNet(10)
    model.net[0] = nn.Linear(10, 16)  # Smaller first layer
    train_pytorch_model(model, X_train_res, y_train_res, X_test, y_test, epochs=80)

    model_dir = os.path.join(MODELS_DIR, 'onnx-anomaly')
    os.makedirs(model_dir, exist_ok=True)

    model.eval()
    dummy = torch.randn(1, 10)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=18)

    acc, roc = evaluate_pytorch_model(model, X_test, y_test)

    # Save metadata with examples
    normal_idx = np.where(y_test == 0)[0][0]
    anomaly_idx = np.where(y_test == 1)[0][0]
    metadata = {
        "name": "sensor-anomaly-10",
        "version": "3.0.0",
        "type": "onnx",
        "inputShape": [1, 10],
        "accuracy": float(acc),
        "rocAuc": float(roc),
        "normalExample": X_test[normal_idx].tolist(),
        "anomalyExample": X_test[anomaly_idx].tolist(),
        "description": "10-sensor industrial monitoring with cross-correlation detection",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'model_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")

    # --- Vibration/Bearing Model ---
    print("\n" + "="*60)
    print("Training Vibration Analysis Model (ONNX) - REALISTIC")
    print("="*60)

    X, y = generator.generate_vibration_features(12000, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')

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
    train_pytorch_model(model, X_train_res, y_train_res, X_test, y_test, epochs=80)

    model_dir = os.path.join(MODELS_DIR, 'pytorch-vibration')
    os.makedirs(model_dir, exist_ok=True)

    model.eval()
    dummy = torch.randn(1, 8)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=18)

    acc, roc = evaluate_pytorch_model(model, X_test, y_test)

    # Save with examples
    normal_idx = np.where(y_test == 0)[0][0]
    anomaly_idx = np.where(y_test == 1)[0][0]
    metadata = {
        "name": "vibration-bearing-analysis",
        "version": "3.0.0",
        "type": "onnx",
        "inputShape": [1, 8],
        "accuracy": float(acc),
        "rocAuc": float(roc),
        "normalExample": X_test[normal_idx].tolist(),
        "anomalyExample": X_test[anomaly_idx].tolist(),
        "description": "Bearing fault detection from vibration features (RMS, Peak, Crest, Kurtosis, etc.)",
        "features": ["rms", "peak", "crest_factor", "kurtosis", "skewness", "dominant_freq", "spectral_centroid", "band_energy"],
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'model_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")

    # --- 8-Sensor Motor/Pump Model ---
    print("\n" + "="*60)
    print("Training 8-Sensor Motor/Pump Model (ONNX) - REALISTIC")
    print("="*60)

    X, y = generator.generate_8sensor_motor_data(12000, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')
    X_train_res = add_feature_noise(X_train_res)
    y_train_res = add_label_noise(y_train_res)

    class MotorNet(nn.Module):
        def __init__(self):
            super().__init__()
            # Smaller network with higher regularization for realistic uncertainty
            self.net = nn.Sequential(
                nn.Linear(8, 12),
                nn.ReLU(),
                nn.Dropout(0.5),
                nn.Linear(12, 6),
                nn.ReLU(),
                nn.Dropout(0.4),
                nn.Linear(6, 1),
                nn.Sigmoid()
            )
        def forward(self, x):
            return self.net(x)

    model = MotorNet()
    train_pytorch_model(model, X_train_res, y_train_res, X_test, y_test, epochs=60)

    model_dir = os.path.join(MODELS_DIR, 'sensor-anomaly-onnx')
    os.makedirs(model_dir, exist_ok=True)

    model.eval()
    dummy = torch.randn(1, 8)
    torch.onnx.export(model, dummy, os.path.join(model_dir, 'model.onnx'),
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      opset_version=18)

    acc, roc = evaluate_pytorch_model(model, X_test, y_test)

    # Find representative examples
    normal_mask = y_test == 0
    anomaly_mask = y_test == 1
    normal_idx = np.where(normal_mask)[0][0]
    anomaly_idx = np.where(anomaly_mask)[0][0]

    metadata = {
        "name": "motor-pump-anomaly-8sensor",
        "version": "3.0.0",
        "type": "onnx",
        "inputShape": [1, 8],
        "accuracy": float(acc),
        "rocAuc": float(roc),
        "normalExample": X_test[normal_idx].tolist(),
        "anomalyExample": X_test[anomaly_idx].tolist(),
        "description": "8-sensor motor/pump monitoring: bearing failure, overload, cavitation (REALISTIC)",
        "anomalyTypes": ["borderline", "bearing_failure", "motor_overload", "pump_cavitation"],
        "sensorLabels": ["temp", "vibration", "pressure", "power", "speed", "flow", "current", "humidity"],
        "realisticTraining": True,
        "expectedOutputs": {
            "normal": "0.15-0.30",
            "borderline": "0.40-0.60",
            "clearAnomaly": "0.70-0.90"
        },
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'model_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")

    # --- Defect Detector Model ---
    print("\n" + "="*60)
    print("Training Defect Detector Model (ONNX)")
    print("="*60)

    model_dir = os.path.join(MODELS_DIR, 'defect-detector-onnx')
    os.makedirs(model_dir, exist_ok=True)

    # Create a simple classifier for "defects" (64 features)
    X_defect = np.random.rand(5000, 64).astype(np.float32)
    # Add some structure to make it learnable but not trivial
    y_defect = ((X_defect[:, :8].mean(axis=1) > 0.55) |
                (X_defect[:, 8:16].std(axis=1) > 0.32)).astype(np.float32)

    X_tr, X_te, y_tr, y_te = train_test_split(X_defect, y_defect, test_size=0.2, random_state=42)
    X_tr_res, y_tr_res = apply_resampling(X_tr, y_tr, 'smote')

    class DefectNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(64, 32),
                nn.ReLU(),
                nn.Dropout(0.2),
                nn.Linear(32, 16),
                nn.ReLU(),
                nn.Linear(16, 1),
                nn.Sigmoid()
            )
        def forward(self, x):
            return self.net(x)

    defect_model = DefectNet()
    train_pytorch_model(defect_model, X_tr_res, y_tr_res, X_te, y_te, epochs=50, verbose=False)

    defect_model.eval()
    dummy = torch.randn(1, 64)
    torch.onnx.export(defect_model, dummy, os.path.join(model_dir, 'model.onnx'),
                     input_names=['input'], output_names=['output'],
                     dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                     opset_version=18)

    acc, roc = evaluate_pytorch_model(defect_model, X_te, y_te)

    normal_idx = np.where(y_te == 0)[0][0]
    anomaly_idx = np.where(y_te == 1)[0][0]
    metadata = {
        "name": "defect-detector",
        "version": "3.0.0",
        "type": "onnx",
        "inputShape": [1, 64],
        "accuracy": float(acc),
        "rocAuc": float(roc),
        "normalExample": X_te[normal_idx].tolist(),
        "anomalyExample": X_te[anomaly_idx].tolist(),
        "description": "Defect classification from 64 feature vectors",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'model_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    save_scaler(model_dir, X_tr)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")


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
    """Evaluate PyTorch model accuracy and ROC-AUC"""
    model.eval()
    with torch.no_grad():
        X_t = torch.FloatTensor(X_test)
        y_t = torch.FloatTensor(y_test).unsqueeze(1)
        probs = model(X_t)
        pred = (probs > 0.5).float()
        acc = (pred == y_t).float().mean().item()

        # Calculate ROC-AUC
        try:
            roc = roc_auc_score(y_test, probs.numpy())
        except:
            roc = 0.5

    return acc, roc


# =============================================================================
# KERAS / TENSORFLOW MODELS
# =============================================================================

def train_keras_models():
    """Train Keras models (.keras and .h5)"""
    if not HAS_TF:
        print("Skipping Keras models - TensorFlow not available")
        return

    generator = RealisticIndustrialDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)

    print("\n" + "="*60)
    print("Training Keras Anomaly Model (.keras) - REALISTIC")
    print("="*60)

    X, y = generator.generate_multi_sensor_data(8000, n_sensors=5, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Apply SMOTE, then add noise for realistic uncertainty
    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')
    X_train_res = add_feature_noise(X_train_res)
    y_train_res = add_label_noise(y_train_res)

    # Smaller network with L2 regularization for realistic uncertainty
    model = keras.Sequential([
        keras.layers.Input(shape=(5,)),
        keras.layers.Dense(12, activation='relu', kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.5),
        keras.layers.Dense(6, activation='relu', kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.4),
        keras.layers.Dense(1, activation='sigmoid')
    ])

    model.compile(optimizer=keras.optimizers.Adam(learning_rate=0.002),
                  loss='binary_crossentropy', metrics=['accuracy'])

    model.fit(X_train_res, y_train_res, epochs=40, batch_size=64,
              validation_split=0.15, verbose=1,
              callbacks=[keras.callbacks.EarlyStopping(patience=8, restore_best_weights=True)])

    _, acc = model.evaluate(X_test, y_test, verbose=0)
    probs = model.predict(X_test, verbose=0)
    try:
        roc = roc_auc_score(y_test, probs)
    except:
        roc = 0.5

    # Save .keras format
    model_dir = os.path.join(MODELS_DIR, 'keras-anomaly')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.keras'))
    save_metadata(model_dir, "keras-sensor-anomaly", "keras", [1, 5],
                  "5-sensor anomaly detection (Keras 3 format) - REALISTIC",
                  accuracy=acc, roc_auc=roc)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")

    # Save .h5 format
    model_dir = os.path.join(MODELS_DIR, 'keras-h5-anomaly')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.h5'))
    save_metadata(model_dir, "keras-sensor-anomaly-h5", "keras-h5", [1, 5],
                  "5-sensor anomaly detection (Legacy HDF5 format) - REALISTIC",
                  accuracy=acc, roc_auc=roc)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")


def train_tflite_model():
    """Train and convert TFLite model"""
    if not HAS_TF:
        print("Skipping TFLite model - TensorFlow not available")
        return

    generator = RealisticIndustrialDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)

    print("\n" + "="*60)
    print("Training TFLite Anomaly Model - REALISTIC")
    print("="*60)

    X, y = generator.generate_multi_sensor_data(6000, n_sensors=5, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')
    X_train_res = add_feature_noise(X_train_res)
    y_train_res = add_label_noise(y_train_res)

    # Small network for edge devices with regularization
    model = keras.Sequential([
        keras.layers.Input(shape=(5,)),
        keras.layers.Dense(10, activation='relu', kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.4),
        keras.layers.Dense(1, activation='sigmoid')
    ])

    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    model.fit(X_train_res, y_train_res, epochs=25, batch_size=64, validation_split=0.15, verbose=1)

    _, acc = model.evaluate(X_test, y_test, verbose=0)
    probs = model.predict(X_test, verbose=0)
    try:
        roc = roc_auc_score(y_test, probs)
    except:
        roc = 0.5

    # Convert to TFLite
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    tflite_model = converter.convert()

    model_dir = os.path.join(MODELS_DIR, 'sensor-tflite')
    os.makedirs(model_dir, exist_ok=True)

    with open(os.path.join(model_dir, 'model.tflite'), 'wb') as f:
        f.write(tflite_model)

    # Find examples
    normal_idx = np.where(y_test == 0)[0][0]
    anomaly_idx = np.where(y_test == 1)[0][0]

    metadata = {
        "name": "sensor-tflite",
        "version": "3.0.0",
        "type": "tflite",
        "inputShape": [1, 5],
        "accuracy": float(acc),
        "rocAuc": float(roc),
        "normalExample": X_test[normal_idx].tolist(),
        "anomalyExample": X_test[anomaly_idx].tolist(),
        "description": "5-sensor anomaly detection optimized for edge devices - REALISTIC",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'model_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir} (Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f})")


# =============================================================================
# SCIKIT-LEARN MODELS
# =============================================================================

def train_sklearn_models():
    """Train scikit-learn models"""
    if not HAS_SKLEARN:
        print("Skipping sklearn models - scikit-learn not available")
        return

    generator = RealisticIndustrialDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)

    print("\n" + "="*60)
    print("Training Random Forest Model (.pkl) - REALISTIC")
    print("="*60)

    X, y = generator.generate_multi_sensor_data(10000, n_sensors=5, anomaly_ratio=IMBALANCE_RATIO)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Apply SMOTE, then add noise for realistic uncertainty
    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')
    X_train_res = add_feature_noise(X_train_res)
    y_train_res = add_label_noise(y_train_res)

    # Weaker RF to prevent overfitting
    rf_model = RandomForestClassifier(
        n_estimators=50,       # Fewer trees
        max_depth=4,           # Shallower trees
        min_samples_split=20,  # Require more samples to split
        min_samples_leaf=10,   # Require more samples per leaf
        max_features='sqrt',   # Limit features per tree
        random_state=42,
        n_jobs=-1
    )
    rf_model.fit(X_train_res, y_train_res)

    y_pred = rf_model.predict(X_test)
    y_prob = rf_model.predict_proba(X_test)[:, 1]
    acc = accuracy_score(y_test, y_pred)
    roc = roc_auc_score(y_test, y_prob)

    print(f"Random Forest - Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f}")
    print(classification_report(y_test, y_pred, target_names=['Normal', 'Anomaly']))

    model_dir = os.path.join(MODELS_DIR, 'sklearn-rf')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(rf_model, os.path.join(model_dir, 'model.pkl'))
    save_metadata(model_dir, "random-forest-anomaly", "sklearn-rf", [1, 5],
                  "Random Forest classifier for sensor anomaly detection - REALISTIC",
                  accuracy=acc, roc_auc=roc)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir}")

    print("\n" + "="*60)
    print("Training Gradient Boosting Model (.joblib) - REALISTIC")
    print("="*60)

    # Weaker GB to prevent overfitting
    gb_model = GradientBoostingClassifier(
        n_estimators=40,        # Fewer boosting rounds
        max_depth=3,            # Shallower trees
        learning_rate=0.05,     # Slower learning
        min_samples_split=20,
        min_samples_leaf=10,
        subsample=0.8,          # Add randomness
        random_state=42
    )
    gb_model.fit(X_train_res, y_train_res)

    y_pred = gb_model.predict(X_test)
    y_prob = gb_model.predict_proba(X_test)[:, 1]
    acc = accuracy_score(y_test, y_pred)
    roc = roc_auc_score(y_test, y_prob)

    print(f"Gradient Boosting - Accuracy: {acc:.2%}, ROC-AUC: {roc:.3f}")
    print(classification_report(y_test, y_pred, target_names=['Normal', 'Anomaly']))

    model_dir = os.path.join(MODELS_DIR, 'sklearn-gb')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(gb_model, os.path.join(model_dir, 'model.joblib'))
    save_metadata(model_dir, "gradient-boosting-anomaly", "sklearn-gb", [1, 5],
                  "Gradient Boosting classifier for sensor anomaly detection - REALISTIC",
                  accuracy=acc, roc_auc=roc)
    save_scaler(model_dir, X_train)
    print(f"Saved to {model_dir}")


# =============================================================================
# USE-CASE SPECIFIC MODELS
# =============================================================================

class UseCaseDataGenerator:
    """Generate realistic data for specific industrial use cases"""

    def __init__(self, seed=42, overlap_ratio=0.3):
        np.random.seed(seed)
        self.overlap_ratio = overlap_ratio

    # -------------------------------------------------------------------------
    # USE CASE: BEARING RUL
    # -------------------------------------------------------------------------
    def generate_bearing_rul_data(self, n_samples=5000):
        """
        Generate bearing RUL (Remaining Useful Life) data.
        Features: vib_rms, vib_peak, crest_factor, kurtosis, defect_freq_amp,
                  temperature, debris_count, hf_energy, rpm, load_factor
        Target: RUL in days (0-200)
        """
        features = []
        rul_values = []

        for _ in range(n_samples):
            # RUL determines degradation level
            rul = np.random.uniform(0, 200)
            degradation = 1 - (rul / 200)  # 0=new, 1=failed

            # Add overlap/noise to make prediction harder
            noise = np.random.normal(0, 0.15)
            degradation = np.clip(degradation + noise, 0, 1)

            # Features based on degradation
            vib_rms = 1.5 + degradation * 8 + np.random.normal(0, 0.5)
            vib_peak = vib_rms * (2.5 + degradation * 2) + np.random.normal(0, 1)
            crest_factor = vib_peak / (vib_rms + 0.1)
            kurtosis = 3 + degradation * 6 + np.random.normal(0, 0.5)
            defect_freq = degradation * 0.8 + np.random.normal(0, 0.1)
            temperature = 40 + degradation * 30 + np.random.normal(0, 3)
            debris = int(degradation * 50 + np.random.normal(0, 5))
            hf_energy = 0.1 + degradation * 0.7 + np.random.normal(0, 0.1)
            rpm = 1500 + np.random.normal(0, 50)
            load = 0.6 + np.random.normal(0, 0.15)

            features.append([
                max(0.5, vib_rms), max(1, vib_peak), max(2, crest_factor),
                max(2.5, kurtosis), max(0, defect_freq), max(30, temperature),
                max(0, debris), max(0, hf_energy), max(500, rpm), np.clip(load, 0.2, 1)
            ])
            rul_values.append(max(0, rul))

        return np.array(features, dtype=np.float32), np.array(rul_values, dtype=np.float32)

    # -------------------------------------------------------------------------
    # USE CASE: MOTOR FAULT CLASSIFICATION
    # -------------------------------------------------------------------------
    def generate_motor_fault_data(self, n_samples=6000):
        """
        Generate motor fault classification data.
        22 Features, 7 classes: normal, bearing_fault, broken_rotor_bar,
        eccentricity, misalignment, stator_fault, unbalance
        """
        classes = ['normal', 'bearing_fault', 'broken_rotor_bar',
                   'eccentricity', 'misalignment', 'stator_fault', 'unbalance']

        features = []
        labels = []

        # Class distribution with borderline cases
        samples_per_class = n_samples // len(classes)

        for class_idx, fault_type in enumerate(classes):
            for i in range(samples_per_class):
                # Base normal values
                Ia = 10 + np.random.normal(0, 0.3)
                Ib = 10 + np.random.normal(0, 0.3)
                Ic = 10 + np.random.normal(0, 0.3)
                I_avg = (Ia + Ib + Ic) / 3
                imbalance = np.std([Ia, Ib, Ic]) / I_avg
                thd = 0.03 + np.random.normal(0, 0.01)
                vib_rms = 2 + np.random.normal(0, 0.3)
                vib_peak = vib_rms * 2.5 + np.random.normal(0, 0.5)
                vib_kurtosis = 3 + np.random.normal(0, 0.3)

                # Borderline case (30% of samples per class)
                is_borderline = i < samples_per_class * self.overlap_ratio

                if fault_type == 'bearing_fault':
                    severity = 0.3 if is_borderline else 0.8
                    vib_rms += severity * 5
                    vib_peak += severity * 12
                    vib_kurtosis += severity * 4
                elif fault_type == 'broken_rotor_bar':
                    severity = 0.3 if is_borderline else 0.7
                    imbalance += severity * 0.08
                    thd += severity * 0.05
                elif fault_type == 'eccentricity':
                    severity = 0.3 if is_borderline else 0.75
                    imbalance += severity * 0.06
                    vib_rms += severity * 2
                elif fault_type == 'misalignment':
                    severity = 0.3 if is_borderline else 0.8
                    vib_rms += severity * 3
                    vib_peak += severity * 8
                elif fault_type == 'stator_fault':
                    severity = 0.3 if is_borderline else 0.7
                    imbalance += severity * 0.1
                    thd += severity * 0.08
                    Ia += severity * 2
                elif fault_type == 'unbalance':
                    severity = 0.3 if is_borderline else 0.75
                    vib_rms += severity * 4
                    vib_peak += severity * 10

                # Build feature vector (22 features)
                f = [
                    Ia, Ib, Ic, I_avg, imbalance,
                    I_avg * 0.95, thd,
                    thd * 0.3, thd * 0.2, thd * 0.15, thd * 0.1,  # sidebands
                    vib_rms, vib_peak, vib_peak / vib_rms,
                    vib_kurtosis,
                    vib_rms * 0.3, vib_rms * 0.25, vib_rms * 0.2, vib_rms * 0.15, vib_rms * 0.1,
                    50 + np.random.normal(0, 5),  # dominant freq
                    0.7 + np.random.normal(0, 0.1)  # load factor
                ]
                features.append(f)
                labels.append(class_idx)

        X = np.array(features, dtype=np.float32)
        y = np.array(labels, dtype=np.int32)

        # Shuffle
        idx = np.random.permutation(len(X))
        return X[idx], y[idx], classes

    # -------------------------------------------------------------------------
    # USE CASE: PUMP MONITORING
    # -------------------------------------------------------------------------
    def generate_pump_data(self, n_samples=5000):
        """
        Generate pump monitoring data.
        12 Features: flow, p_inlet, p_outlet, current, vibration_rms,
                     bearing_temp, delta_p, efficiency, specific_energy,
                     temp_rise, vib_flow_ratio, npsh_margin
        Classes: normal, cavitation, bearing_wear, seal_leak, impeller_damage
        """
        classes = ['normal', 'cavitation', 'bearing_wear', 'seal_leak', 'impeller_damage']
        features = []
        labels = []

        samples_per_class = n_samples // len(classes)

        for class_idx, fault_type in enumerate(classes):
            for i in range(samples_per_class):
                is_borderline = i < samples_per_class * self.overlap_ratio

                # Base normal values
                flow = 100 + np.random.normal(0, 5)
                p_inlet = 1.5 + np.random.normal(0, 0.1)
                p_outlet = 5 + np.random.normal(0, 0.2)
                current = 15 + np.random.normal(0, 0.5)
                vib = 2 + np.random.normal(0, 0.3)
                temp = 45 + np.random.normal(0, 2)

                severity = 0.35 if is_borderline else 0.8

                if fault_type == 'cavitation':
                    p_inlet -= severity * 0.8
                    vib += severity * 4
                    flow -= severity * 20
                elif fault_type == 'bearing_wear':
                    vib += severity * 5
                    temp += severity * 15
                    current += severity * 2
                elif fault_type == 'seal_leak':
                    flow -= severity * 15
                    p_outlet -= severity * 0.5
                elif fault_type == 'impeller_damage':
                    flow -= severity * 25
                    vib += severity * 3
                    current += severity * 3

                delta_p = p_outlet - p_inlet
                efficiency = max(0.3, 0.85 - (1 if fault_type != 'normal' else 0) * severity * 0.3)
                specific_energy = current * 400 / max(10, flow)
                temp_rise = temp - 35
                vib_flow_ratio = vib / max(10, flow) * 100
                npsh_margin = max(0.1, p_inlet - 0.5)

                features.append([
                    flow, p_inlet, p_outlet, current, vib, temp,
                    delta_p, efficiency, specific_energy, temp_rise,
                    vib_flow_ratio, npsh_margin
                ])
                labels.append(class_idx)

        X = np.array(features, dtype=np.float32)
        y = np.array(labels, dtype=np.int32)

        idx = np.random.permutation(len(X))
        return X[idx], y[idx], classes

    # -------------------------------------------------------------------------
    # USE CASE: HVAC SYSTEM
    # -------------------------------------------------------------------------
    def generate_hvac_data(self, n_samples=5000):
        """
        Generate HVAC system data.
        17 Features, 5 classes: normal, clogged_filter, damper_stuck,
                                fan_belt_wear, refrigerant_leak
        """
        classes = ['normal', 'clogged_filter', 'damper_stuck',
                   'fan_belt_wear', 'refrigerant_leak']
        features = []
        labels = []

        samples_per_class = n_samples // len(classes)

        for class_idx, fault_type in enumerate(classes):
            for i in range(samples_per_class):
                is_borderline = i < samples_per_class * self.overlap_ratio
                severity = 0.35 if is_borderline else 0.8

                # Base values
                outdoor_temp = 30 + np.random.normal(0, 5)
                return_temp = 24 + np.random.normal(0, 1)
                supply_temp = 14 + np.random.normal(0, 1)
                airflow = 1000 + np.random.normal(0, 50)
                fan_power = 2 + np.random.normal(0, 0.1)
                filter_dp = 0.4 + np.random.normal(0, 0.05)
                fan_vib = 0.1 + np.random.normal(0, 0.02)
                chw_valve = 0.6 + np.random.normal(0, 0.1)

                if fault_type == 'clogged_filter':
                    filter_dp += severity * 0.8
                    airflow -= severity * 200
                    fan_power += severity * 0.5
                elif fault_type == 'damper_stuck':
                    outdoor_temp_effect = severity * 5
                    return_temp += outdoor_temp_effect * 0.3
                elif fault_type == 'fan_belt_wear':
                    fan_vib += severity * 0.3
                    airflow -= severity * 150
                    fan_power += severity * 0.3
                elif fault_type == 'refrigerant_leak':
                    supply_temp += severity * 4
                    chw_valve = min(1, chw_valve + severity * 0.3)

                mixed_temp = (outdoor_temp * 0.3 + return_temp * 0.7)
                delta_t_coil = return_temp - supply_temp
                delta_t_room = return_temp - 22
                fan_eff = max(0.4, 0.75 - (filter_dp - 0.4) * 0.5)
                filter_loading = filter_dp / 1.2
                spf = fan_power / max(100, airflow) * 1000
                econ_eff = max(0, min(1, (outdoor_temp - 15) / 20))
                cool_eff = delta_t_coil / max(1, chw_valve * 20)
                vib_airflow = fan_vib / max(100, airflow) * 10000

                features.append([
                    outdoor_temp, return_temp, mixed_temp, supply_temp,
                    airflow, fan_power, filter_dp, fan_vib, chw_valve,
                    delta_t_coil, delta_t_room, fan_eff, filter_loading,
                    spf, econ_eff, cool_eff, vib_airflow
                ])
                labels.append(class_idx)

        X = np.array(features, dtype=np.float32)
        y = np.array(labels, dtype=np.int32)

        idx = np.random.permutation(len(X))
        return X[idx], y[idx], classes

    # -------------------------------------------------------------------------
    # USE CASE: CNC TOOL WEAR
    # -------------------------------------------------------------------------
    def generate_cnc_data(self, n_samples=5000):
        """
        Generate CNC tool wear data.
        18 Features, outputs: wear_vb (mm), remaining_life (min), state
        States: new, good, worn, critical
        """
        states = ['new', 'good', 'worn', 'critical']
        features = []
        wear_values = []
        rtl_values = []
        state_labels = []

        for _ in range(n_samples):
            # Wear determines everything
            wear = np.random.uniform(0, 0.35)
            wear += np.random.normal(0, 0.02)  # Add noise
            wear = np.clip(wear, 0, 0.35)

            # RTL inversely related to wear
            max_rtl = 60
            rtl = max(0, max_rtl * (1 - wear / 0.3))
            rtl += np.random.normal(0, 2)
            rtl = np.clip(rtl, 0, max_rtl)

            # State based on wear
            if wear < 0.08:
                state = 0  # new
            elif wear < 0.18:
                state = 1  # good
            elif wear < 0.28:
                state = 2  # worn
            else:
                state = 3  # critical

            # Features based on wear
            force_x = 200 + wear * 400 + np.random.normal(0, 20)
            force_y = 150 + wear * 350 + np.random.normal(0, 15)
            force_z = 100 + wear * 250 + np.random.normal(0, 10)
            force_r = np.sqrt(force_x**2 + force_y**2 + force_z**2)
            current = 5 + wear * 8 + np.random.normal(0, 0.5)
            vib = 1 + wear * 6 + np.random.normal(0, 0.3)
            ae = 0.5 + wear * 3 + np.random.normal(0, 0.2)
            temp = 40 + wear * 60 + np.random.normal(0, 3)
            power = 1.5 + wear * 3 + np.random.normal(0, 0.2)
            spindle = 3000 + np.random.normal(0, 50)
            feed = 200 + np.random.normal(0, 10)
            doc = 1.5 + np.random.normal(0, 0.1)

            features.append([
                force_x, force_y, force_z, force_r, current, vib, ae, temp, power,
                spindle, feed, doc,
                force_x / max(1, force_y), force_z / max(1, force_r),
                power / max(1, force_r) * 1000, power / max(0.1, force_r),
                vib / max(0.1, force_r), ae / max(0.1, vib)
            ])
            wear_values.append(wear)
            rtl_values.append(rtl)
            state_labels.append(state)

        X = np.array(features, dtype=np.float32)
        y_wear = np.array(wear_values, dtype=np.float32)
        y_rtl = np.array(rtl_values, dtype=np.float32)
        y_state = np.array(state_labels, dtype=np.int32)

        idx = np.random.permutation(len(X))
        return X[idx], y_wear[idx], y_rtl[idx], y_state[idx], states


def train_usecase_models():
    """Train all use-case specific models"""
    if not HAS_SKLEARN:
        print("Skipping use-case models - scikit-learn not available")
        return

    generator = UseCaseDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)

    # =========================================================================
    # BEARING RUL
    # =========================================================================
    print("\n" + "="*60)
    print("Training BEARING RUL Models (usecase_bearing)")
    print("="*60)

    X, y = generator.generate_bearing_rul_data(5000)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Gradient Boosting for RUL
    gb_model = GradientBoostingRegressor(
        n_estimators=100, max_depth=5, learning_rate=0.1,
        min_samples_split=10, random_state=42
    )
    gb_model.fit(X_train_scaled, y_train)
    y_pred = gb_model.predict(X_test_scaled)

    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    print(f"  Gradient Boosting RUL - RMSE: {rmse:.2f}, MAE: {mae:.2f}, R2: {r2:.3f}")

    model_dir = os.path.join(MODELS_DIR, 'usecase_bearing')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(gb_model, os.path.join(model_dir, 'bearing_rul_gb.joblib'))
    joblib.dump(scaler, os.path.join(model_dir, 'bearing_scaler.joblib'))

    # LSTM for RUL (if TensorFlow available)
    if HAS_TF:
        seq_length = 30
        # Create sequences
        X_seq = []
        y_seq = []
        for i in range(len(X_train_scaled) - seq_length):
            X_seq.append(X_train_scaled[i:i+seq_length])
            y_seq.append(y_train[i+seq_length])
        X_seq = np.array(X_seq)
        y_seq = np.array(y_seq)

        lstm_model = keras.Sequential([
            keras.layers.Input(shape=(seq_length, X.shape[1])),
            keras.layers.LSTM(32, return_sequences=True),
            keras.layers.Dropout(0.2),
            keras.layers.LSTM(16),
            keras.layers.Dropout(0.2),
            keras.layers.Dense(8, activation='relu'),
            keras.layers.Dense(1)
        ])
        lstm_model.compile(optimizer='adam', loss='mse', metrics=['mae'])
        lstm_model.fit(X_seq, y_seq, epochs=30, batch_size=32, validation_split=0.1, verbose=0)
        lstm_model.save(os.path.join(model_dir, 'bearing_rul_lstm.keras'))
        print(f"  LSTM RUL model saved")

    metadata = {
        "models": {
            "gradient_boosting": {"file": "bearing_rul_gb.joblib", "rmse": rmse, "mae": mae, "r2": r2},
            "lstm": {"file": "bearing_rul_lstm.keras", "seq_length": 30}
        },
        "features": ["vib_rms", "vib_peak", "crest_factor", "kurtosis", "defect_freq_amp",
                     "temperature", "debris_count", "hf_energy", "rpm", "load_factor"],
        "max_rul": 200,
        "realisticTraining": True
    }
    with open(os.path.join(model_dir, 'bearing_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"  Saved to {model_dir}")

    # =========================================================================
    # MOTOR FAULT CLASSIFICATION
    # =========================================================================
    print("\n" + "="*60)
    print("Training MOTOR Fault Classification (usecase_motor)")
    print("="*60)

    X, y, classes = generator.generate_motor_fault_data(6000)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    X_train_res, y_train_res = apply_resampling(X_train_scaled, y_train, 'smote')

    rf_model = RandomForestClassifier(
        n_estimators=100, max_depth=10, min_samples_split=5,
        random_state=42, n_jobs=-1
    )
    rf_model.fit(X_train_res, y_train_res)
    y_pred = rf_model.predict(X_test_scaled)
    acc = accuracy_score(y_test, y_pred)
    print(f"  Motor Fault RF - Accuracy: {acc:.2%}")
    print(classification_report(y_test, y_pred, target_names=classes))

    model_dir = os.path.join(MODELS_DIR, 'usecase_motor')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(rf_model, os.path.join(model_dir, 'motor_classifier_rf.joblib'))
    joblib.dump(scaler, os.path.join(model_dir, 'motor_scaler.joblib'))

    le = LabelEncoder()
    le.fit(classes)
    joblib.dump(le, os.path.join(model_dir, 'motor_label_encoder.joblib'))

    metadata = {
        "model": "Random Forest Classifier",
        "features": ["Ia_rms", "Ib_rms", "Ic_rms", "I_avg", "current_imbalance",
                     "I_fundamental", "THD", "sideband_2pct", "sideband_3pct",
                     "sideband_4pct", "sideband_5pct", "vib_rms", "vib_peak",
                     "vib_crest", "vib_kurtosis", "vib_band_0_100", "vib_band_100_500",
                     "vib_band_500_1000", "vib_band_1000_3000", "vib_band_3000_5000",
                     "vib_dominant_freq", "load_factor"],
        "classes": classes,
        "accuracy": float(acc),
        "realisticTraining": True
    }
    with open(os.path.join(model_dir, 'motor_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"  Saved to {model_dir}")

    # =========================================================================
    # PUMP MONITORING
    # =========================================================================
    print("\n" + "="*60)
    print("Training PUMP Monitoring Models (usecase_pump)")
    print("="*60)

    X, y, classes = generator.generate_pump_data(5000)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    scaler_clf = StandardScaler()
    X_train_scaled = scaler_clf.fit_transform(X_train)
    X_test_scaled = scaler_clf.transform(X_test)

    X_train_res, y_train_res = apply_resampling(X_train_scaled, y_train, 'smote')

    # Classifier
    rf_clf = RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42, n_jobs=-1)
    rf_clf.fit(X_train_res, y_train_res)
    acc = accuracy_score(y_test, rf_clf.predict(X_test_scaled))
    print(f"  Pump Classifier RF - Accuracy: {acc:.2%}")

    # Anomaly detector (normal vs fault)
    y_anomaly = (y != 0).astype(int)
    y_train_anom = (y_train != 0).astype(int)
    scaler_anom = StandardScaler()
    X_train_anom = scaler_anom.fit_transform(X_train)

    iforest = IsolationForest(n_estimators=100, contamination=0.2, random_state=42)
    iforest.fit(X_train_anom[y_train_anom == 0])  # Train on normal only

    model_dir = os.path.join(MODELS_DIR, 'usecase_pump')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(rf_clf, os.path.join(model_dir, 'pump_classifier_rf.joblib'))
    joblib.dump(iforest, os.path.join(model_dir, 'pump_anomaly_iforest.joblib'))
    joblib.dump(scaler_clf, os.path.join(model_dir, 'pump_scaler_classifier.joblib'))
    joblib.dump(scaler_anom, os.path.join(model_dir, 'pump_scaler_anomaly.joblib'))

    with open(os.path.join(model_dir, 'pump_features.json'), 'w') as f:
        json.dump({
            "features": ["flow", "p_inlet", "p_outlet", "current", "vibration_rms",
                        "bearing_temp", "delta_p", "efficiency", "specific_energy",
                        "temp_rise", "vib_flow_ratio", "npsh_margin"],
            "realisticTraining": True
        }, f, indent=2)

    with open(os.path.join(model_dir, 'pump_label_map.json'), 'w') as f:
        json.dump({str(i): c for i, c in enumerate(classes)}, f, indent=2)

    print(f"  Saved to {model_dir}")

    # =========================================================================
    # HVAC SYSTEM
    # =========================================================================
    print("\n" + "="*60)
    print("Training HVAC System Models (usecase_hvac)")
    print("="*60)

    X, y, classes = generator.generate_hvac_data(5000)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    scaler_clf = StandardScaler()
    X_train_scaled = scaler_clf.fit_transform(X_train)
    X_test_scaled = scaler_clf.transform(X_test)

    X_train_res, y_train_res = apply_resampling(X_train_scaled, y_train, 'smote')

    rf_clf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1)
    rf_clf.fit(X_train_res, y_train_res)
    acc = accuracy_score(y_test, rf_clf.predict(X_test_scaled))
    print(f"  HVAC Classifier RF - Accuracy: {acc:.2%}")

    # Anomaly detector
    y_train_anom = (y_train != 0).astype(int)
    scaler_anom = StandardScaler()
    X_train_anom = scaler_anom.fit_transform(X_train)
    iforest = IsolationForest(n_estimators=100, contamination=0.2, random_state=42)
    iforest.fit(X_train_anom[y_train_anom == 0])

    model_dir = os.path.join(MODELS_DIR, 'usecase_hvac')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(rf_clf, os.path.join(model_dir, 'hvac_classifier_rf.joblib'))
    joblib.dump(iforest, os.path.join(model_dir, 'hvac_anomaly_iforest.joblib'))
    joblib.dump(scaler_clf, os.path.join(model_dir, 'hvac_scaler_classifier.joblib'))
    joblib.dump(scaler_anom, os.path.join(model_dir, 'hvac_scaler_anomaly.joblib'))

    le = LabelEncoder()
    le.fit(classes)
    joblib.dump(le, os.path.join(model_dir, 'hvac_label_encoder.joblib'))

    metadata = {
        "features": ["outdoor_temp", "return_temp", "mixed_temp", "supply_temp",
                    "airflow", "fan_power", "filter_dp", "fan_vibration", "chw_valve",
                    "delta_t_coil", "delta_t_room", "fan_efficiency", "filter_loading",
                    "specific_fan_power", "economizer_eff", "cooling_eff", "vib_airflow_ratio"],
        "classes": classes,
        "accuracy": float(acc),
        "realisticTraining": True
    }
    with open(os.path.join(model_dir, 'hvac_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"  Saved to {model_dir}")

    # =========================================================================
    # CNC TOOL WEAR
    # =========================================================================
    print("\n" + "="*60)
    print("Training CNC Tool Wear Models (usecase_cnc)")
    print("="*60)

    X, y_wear, y_rtl, y_state, states = generator.generate_cnc_data(5000)
    X_train, X_test, yw_train, yw_test, yr_train, yr_test, ys_train, ys_test = \
        train_test_split(X, y_wear, y_rtl, y_state, test_size=0.2, random_state=42)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Wear prediction (regression)
    wear_model = RandomForestRegressor(n_estimators=100, max_depth=8, random_state=42, n_jobs=-1)
    wear_model.fit(X_train_scaled, yw_train)
    yw_pred = wear_model.predict(X_test_scaled)
    wear_rmse = np.sqrt(mean_squared_error(yw_test, yw_pred))
    wear_mae = mean_absolute_error(yw_test, yw_pred)
    print(f"  Wear RF - RMSE: {wear_rmse:.4f}, MAE: {wear_mae:.4f}")

    # RTL prediction
    rtl_model = RandomForestRegressor(n_estimators=100, max_depth=8, random_state=42, n_jobs=-1)
    rtl_model.fit(X_train_scaled, yr_train)
    yr_pred = rtl_model.predict(X_test_scaled)
    rtl_rmse = np.sqrt(mean_squared_error(yr_test, yr_pred))
    rtl_mae = mean_absolute_error(yr_test, yr_pred)
    print(f"  RTL RF - RMSE: {rtl_rmse:.2f}, MAE: {rtl_mae:.2f}")

    # State classification
    X_train_res, ys_train_res = apply_resampling(X_train_scaled, ys_train, 'smote')
    state_model = GradientBoostingClassifier(n_estimators=100, max_depth=5, random_state=42)
    state_model.fit(X_train_res, ys_train_res)
    ys_pred = state_model.predict(X_test_scaled)
    state_acc = accuracy_score(ys_test, ys_pred)
    print(f"  State GB - Accuracy: {state_acc:.2%}")

    model_dir = os.path.join(MODELS_DIR, 'usecase_cnc')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(wear_model, os.path.join(model_dir, 'cnc_wear_rf.joblib'))
    joblib.dump(rtl_model, os.path.join(model_dir, 'cnc_rtl_rf.joblib'))
    joblib.dump(state_model, os.path.join(model_dir, 'cnc_state_gb.joblib'))
    joblib.dump(scaler, os.path.join(model_dir, 'cnc_scaler.joblib'))

    le = LabelEncoder()
    le.fit(states)
    joblib.dump(le, os.path.join(model_dir, 'cnc_label_encoder.joblib'))

    metadata = {
        "features": ["force_x", "force_y", "force_z", "force_resultant", "spindle_current",
                    "vibration_rms", "ae_rms", "temperature", "power_kw", "spindle_speed",
                    "feed_rate", "depth_of_cut", "force_xy_ratio", "force_z_ratio",
                    "specific_energy", "power_force_ratio", "vib_force_ratio", "ae_vib_ratio"],
        "wear_states": states,
        "models": {
            "wear_prediction": {"file": "cnc_wear_rf.joblib", "rmse": float(wear_rmse), "mae": float(wear_mae)},
            "rtl_prediction": {"file": "cnc_rtl_rf.joblib", "rmse": float(rtl_rmse), "mae": float(rtl_mae)},
            "state_classification": {"file": "cnc_state_gb.joblib", "accuracy": float(state_acc)}
        },
        "realisticTraining": True
    }
    with open(os.path.join(model_dir, 'cnc_metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"  Saved to {model_dir}")

    print("\n" + "="*60)
    print("ALL USE-CASE MODELS TRAINED!")
    print("="*60)


# =============================================================================
# NEW MODEL TRAINING FUNCTIONS (7 missing models)
# =============================================================================

class RULSequenceGenerator:
    """Generate realistic degradation sequences for RUL prediction"""

    def __init__(self, seed=42, overlap_ratio=0.3):
        np.random.seed(seed)
        self.overlap_ratio = overlap_ratio
        self.feature_names = [
            'rms', 'peak', 'crest_factor', 'std', 'kurtosis', 'skewness',
            'spectral_centroid', 'spectral_spread', 'band_0_100', 'band_100_200',
            'band_200_500', 'band_500_1000', 'band_1000_3000', 'temperature', 'current'
        ]

    def generate_rul_sequences(self, n_samples=3000, seq_length=30, n_features=15, max_rul=125):
        """
        Generate realistic degradation sequences for RUL prediction.

        Degradation profiles:
        - Linear (60%): RUL decreases linearly
        - Exponential (25%): Accelerated wear near end
        - Sudden (15%): Abrupt failure after stable period
        """
        sequences = []
        rul_values = []

        # Distribution of degradation profiles
        n_linear = int(n_samples * 0.60)
        n_exponential = int(n_samples * 0.25)
        n_sudden = n_samples - n_linear - n_exponential

        for profile_type, count in [('linear', n_linear), ('exponential', n_exponential), ('sudden', n_sudden)]:
            for _ in range(count):
                # Random starting RUL (initial health state)
                initial_rul = np.random.uniform(20, max_rul)

                # Generate sequence
                seq = np.zeros((seq_length, n_features))

                if profile_type == 'linear':
                    # Linear degradation
                    rul_at_end = max(0, initial_rul - np.random.uniform(10, 40))
                    degradation_profile = np.linspace(0, 1 - rul_at_end / max_rul, seq_length)
                elif profile_type == 'exponential':
                    # Exponential degradation (accelerates)
                    rul_at_end = max(0, initial_rul * np.random.uniform(0.1, 0.4))
                    t = np.linspace(0, 3, seq_length)
                    degradation_profile = (np.exp(t) - 1) / (np.exp(3) - 1)
                    degradation_profile = degradation_profile * (1 - rul_at_end / max_rul)
                else:  # sudden
                    # Sudden failure after stable period
                    rul_at_end = max(0, np.random.uniform(0, 15))
                    stable_len = int(seq_length * np.random.uniform(0.5, 0.8))
                    degradation_profile = np.concatenate([
                        np.zeros(stable_len) + np.random.uniform(0.05, 0.2),
                        np.linspace(0.2, 0.9, seq_length - stable_len)
                    ])

                # Generate features based on degradation
                for t in range(seq_length):
                    d = degradation_profile[t]
                    noise = np.random.normal(0, 0.05)

                    # RMS vibration (increases with degradation)
                    seq[t, 0] = 0.2 + d * 0.6 + noise

                    # Peak vibration
                    seq[t, 1] = seq[t, 0] * (2.0 + d * 1.5) + np.random.normal(0, 0.05)

                    # Crest factor
                    seq[t, 2] = seq[t, 1] / max(0.1, seq[t, 0])

                    # Standard deviation
                    seq[t, 3] = 0.1 + d * 0.4 + noise

                    # Kurtosis (increases with bearing faults)
                    seq[t, 4] = 0.2 + d * 0.5 + noise

                    # Skewness
                    seq[t, 5] = 0.05 + d * 0.3 + np.random.normal(0, 0.03)

                    # Spectral centroid (shifts higher with wear)
                    seq[t, 6] = 0.3 + d * 0.4 + noise

                    # Spectral spread
                    seq[t, 7] = 0.2 + d * 0.3 + noise

                    # Frequency bands (normalized)
                    seq[t, 8] = 0.15 + d * 0.25 + noise  # 0-100 Hz
                    seq[t, 9] = 0.2 + d * 0.3 + noise   # 100-200 Hz
                    seq[t, 10] = 0.25 + d * 0.25 + noise  # 200-500 Hz
                    seq[t, 11] = 0.2 + d * 0.35 + noise  # 500-1000 Hz
                    seq[t, 12] = 0.15 + d * 0.4 + noise  # 1000-3000 Hz

                    # Temperature (increases with degradation)
                    seq[t, 13] = 0.3 + d * 0.4 + np.random.normal(0, 0.03)

                    # Current (increases with mechanical issues)
                    seq[t, 14] = 0.35 + d * 0.3 + np.random.normal(0, 0.03)

                # Clip to [0, 1]
                seq = np.clip(seq, 0, 1)

                sequences.append(seq)
                rul_values.append(rul_at_end)

        X = np.array(sequences, dtype=np.float32)
        y = np.array(rul_values, dtype=np.float32)

        # Shuffle
        idx = np.random.permutation(len(X))
        return X[idx], y[idx]


class FaultClassificationGenerator:
    """Generate realistic fault classification data"""

    def __init__(self, seed=42, overlap_ratio=0.3):
        np.random.seed(seed)
        self.overlap_ratio = overlap_ratio
        self.classes = ['normal', 'unbalance', 'bearing', 'misalignment']

    def generate_fault_data(self, n_samples=4000, n_features=13):
        """
        Generate 4-class fault classification data with overlapping borderline cases.

        Features (13): rms, peak, crest_factor, kurtosis, skewness,
                       freq_1x, freq_2x, freq_3x, harmonic_ratio,
                       temperature, current, pressure, efficiency
        """
        features = []
        labels = []

        samples_per_class = n_samples // len(self.classes)

        for class_idx, fault_type in enumerate(self.classes):
            n_borderline = int(samples_per_class * self.overlap_ratio)
            n_clear = samples_per_class - n_borderline

            for i in range(samples_per_class):
                is_borderline = i < n_borderline
                severity = 0.3 if is_borderline else np.random.uniform(0.6, 0.9)

                # Base normal values
                f = [
                    0.25 + np.random.normal(0, 0.05),   # rms
                    0.35 + np.random.normal(0, 0.06),   # peak
                    1.4 + np.random.normal(0, 0.1),    # crest_factor
                    0.2 + np.random.normal(0, 0.04),   # kurtosis
                    0.1 + np.random.normal(0, 0.03),   # skewness
                    0.3 + np.random.normal(0, 0.05),   # freq_1x
                    0.15 + np.random.normal(0, 0.03),  # freq_2x
                    0.08 + np.random.normal(0, 0.02),  # freq_3x
                    0.2 + np.random.normal(0, 0.04),   # harmonic_ratio
                    0.4 + np.random.normal(0, 0.05),   # temperature
                    0.45 + np.random.normal(0, 0.05),  # current
                    0.55 + np.random.normal(0, 0.04),  # pressure
                    0.8 + np.random.normal(0, 0.05),   # efficiency
                ]

                if fault_type == 'unbalance':
                    # High 1x frequency, elevated vibration
                    f[0] += severity * 0.4   # rms
                    f[1] += severity * 0.5   # peak
                    f[5] += severity * 0.45  # freq_1x (dominant!)
                    f[8] += severity * 0.2   # harmonic_ratio
                    f[12] -= severity * 0.15  # efficiency drops

                elif fault_type == 'bearing':
                    # High kurtosis, high frequency content
                    f[0] += severity * 0.35  # rms
                    f[1] += severity * 0.55  # peak
                    f[2] += severity * 0.4   # crest_factor
                    f[3] += severity * 0.5   # kurtosis (high!)
                    f[4] += severity * 0.25  # skewness
                    f[9] += severity * 0.3   # temperature
                    f[10] += severity * 0.2  # current

                elif fault_type == 'misalignment':
                    # High 2x frequency, axial vibration
                    f[0] += severity * 0.3   # rms
                    f[1] += severity * 0.4   # peak
                    f[5] += severity * 0.2   # freq_1x
                    f[6] += severity * 0.5   # freq_2x (dominant!)
                    f[7] += severity * 0.3   # freq_3x
                    f[9] += severity * 0.2   # temperature
                    f[11] -= severity * 0.15  # pressure drop

                features.append(np.clip(f, 0, 1))
                labels.append(class_idx)

        X = np.array(features, dtype=np.float32)
        y = np.array(labels, dtype=np.int32)

        idx = np.random.permutation(len(X))
        return X[idx], y[idx], self.classes


def train_lstm_rul():
    """Train LSTM model for RUL prediction"""
    if not HAS_TF:
        print("Skipping LSTM RUL - TensorFlow not available")
        return

    print("\n" + "="*60)
    print("Training LSTM RUL Model")
    print("="*60)

    generator = RULSequenceGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)
    X, y = generator.generate_rul_sequences(n_samples=3000, seq_length=30, n_features=15, max_rul=125)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # Normalize RUL to [0, 1] for better training
    max_rul = 125
    y_train_norm = y_train / max_rul
    y_test_norm = y_test / max_rul

    # LSTM architecture (simplified for realistic outputs)
    model = keras.Sequential([
        keras.layers.Input(shape=(30, 15)),
        keras.layers.LSTM(32, return_sequences=True, kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.4),
        keras.layers.LSTM(16, kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.3),
        keras.layers.Dense(8, activation='relu'),
        keras.layers.Dense(1, activation='sigmoid')  # Output 0-1, multiply by max_rul
    ])

    model.compile(optimizer=keras.optimizers.Adam(learning_rate=0.001),
                  loss='mse', metrics=['mae'])

    model.fit(X_train, y_train_norm, epochs=50, batch_size=32,
              validation_split=0.15, verbose=1,
              callbacks=[keras.callbacks.EarlyStopping(patience=10, restore_best_weights=True)])

    # Evaluate
    y_pred_norm = model.predict(X_test, verbose=0).flatten()
    y_pred = y_pred_norm * max_rul

    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"  LSTM RUL - RMSE: {rmse:.2f} days, MAE: {mae:.2f} days, R2: {r2:.3f}")

    # Save model
    model_dir = os.path.join(MODELS_DIR, 'lstm-rul')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.keras'))

    # Save scaler (for sequence data, save feature-wise mean/std)
    mean = X_train.mean(axis=(0, 1))
    std = X_train.std(axis=(0, 1)) + 1e-8
    scaler_data = {"mean": mean.tolist(), "scale": std.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)

    # Save metadata
    metadata = {
        "name": "lstm-rul-predictor",
        "version": "3.0.0",
        "type": "keras",
        "task": "rul_prediction",
        "inputShape": [None, 30, 15],
        "seqLength": 30,
        "nFeatures": 15,
        "maxRul": max_rul,
        "features": generator.feature_names,
        "rmse": float(rmse),
        "mae": float(mae),
        "r2": float(r2),
        "description": "LSTM model for Remaining Useful Life prediction from sensor sequences",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_cnn_lstm_rul():
    """Train CNN-LSTM hybrid model for RUL prediction"""
    if not HAS_TF:
        print("Skipping CNN-LSTM RUL - TensorFlow not available")
        return

    print("\n" + "="*60)
    print("Training CNN-LSTM RUL Model")
    print("="*60)

    generator = RULSequenceGenerator(seed=43, overlap_ratio=OVERLAP_RATIO)
    X, y = generator.generate_rul_sequences(n_samples=3000, seq_length=30, n_features=15, max_rul=125)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    max_rul = 125
    y_train_norm = y_train / max_rul
    y_test_norm = y_test / max_rul

    # CNN-LSTM architecture
    model = keras.Sequential([
        keras.layers.Input(shape=(30, 15)),
        keras.layers.Conv1D(16, kernel_size=3, activation='relu', padding='same',
                           kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.MaxPooling1D(pool_size=2),
        keras.layers.Dropout(0.3),
        keras.layers.LSTM(16, kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.4),
        keras.layers.Dense(8, activation='relu'),
        keras.layers.Dense(1, activation='sigmoid')
    ])

    model.compile(optimizer=keras.optimizers.Adam(learning_rate=0.001),
                  loss='mse', metrics=['mae'])

    model.fit(X_train, y_train_norm, epochs=50, batch_size=32,
              validation_split=0.15, verbose=1,
              callbacks=[keras.callbacks.EarlyStopping(patience=10, restore_best_weights=True)])

    y_pred_norm = model.predict(X_test, verbose=0).flatten()
    y_pred = y_pred_norm * max_rul

    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"  CNN-LSTM RUL - RMSE: {rmse:.2f} days, MAE: {mae:.2f} days, R2: {r2:.3f}")

    model_dir = os.path.join(MODELS_DIR, 'cnn-lstm-rul')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.keras'))

    mean = X_train.mean(axis=(0, 1))
    std = X_train.std(axis=(0, 1)) + 1e-8
    scaler_data = {"mean": mean.tolist(), "scale": std.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)

    metadata = {
        "name": "cnn-lstm-rul-predictor",
        "version": "3.0.0",
        "type": "keras",
        "task": "rul_prediction",
        "inputShape": [None, 30, 15],
        "seqLength": 30,
        "nFeatures": 15,
        "maxRul": max_rul,
        "features": generator.feature_names,
        "rmse": float(rmse),
        "mae": float(mae),
        "r2": float(r2),
        "architecture": {"conv1d_filters": 16, "lstm_units": 16},
        "description": "CNN-LSTM hybrid for RUL prediction with feature extraction",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_transformer_rul():
    """Train Transformer model for RUL prediction"""
    if not HAS_TF:
        print("Skipping Transformer RUL - TensorFlow not available")
        return

    print("\n" + "="*60)
    print("Training Transformer RUL Model")
    print("="*60)

    generator = RULSequenceGenerator(seed=44, overlap_ratio=OVERLAP_RATIO)
    X, y = generator.generate_rul_sequences(n_samples=3000, seq_length=30, n_features=15, max_rul=125)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    max_rul = 125
    y_train_norm = y_train / max_rul
    y_test_norm = y_test / max_rul

    # Transformer parameters (smaller for realistic outputs)
    d_model = 32
    num_heads = 2
    ff_dim = 64
    num_layers = 2

    # Build Transformer model
    inputs = keras.layers.Input(shape=(30, 15))

    # Project to d_model dimensions
    x = keras.layers.Dense(d_model)(inputs)

    # Positional encoding (simple learned)
    positions = keras.layers.Embedding(30, d_model)(tf.range(30))
    x = x + positions

    # Transformer blocks
    for _ in range(num_layers):
        # Multi-head attention
        attn_output = keras.layers.MultiHeadAttention(
            num_heads=num_heads, key_dim=d_model // num_heads,
            dropout=0.3
        )(x, x)
        x = keras.layers.LayerNormalization(epsilon=1e-6)(x + attn_output)

        # Feed-forward
        ff_output = keras.layers.Dense(ff_dim, activation='relu',
                                       kernel_regularizer=keras.regularizers.l2(0.01))(x)
        ff_output = keras.layers.Dropout(0.4)(ff_output)
        ff_output = keras.layers.Dense(d_model)(ff_output)
        x = keras.layers.LayerNormalization(epsilon=1e-6)(x + ff_output)

    # Global average pooling
    x = keras.layers.GlobalAveragePooling1D()(x)
    x = keras.layers.Dropout(0.3)(x)
    x = keras.layers.Dense(16, activation='relu')(x)
    outputs = keras.layers.Dense(1, activation='sigmoid')(x)

    model = keras.Model(inputs, outputs)

    model.compile(optimizer=keras.optimizers.Adam(learning_rate=0.001),
                  loss='mse', metrics=['mae'])

    model.fit(X_train, y_train_norm, epochs=50, batch_size=32,
              validation_split=0.15, verbose=1,
              callbacks=[keras.callbacks.EarlyStopping(patience=10, restore_best_weights=True)])

    y_pred_norm = model.predict(X_test, verbose=0).flatten()
    y_pred = y_pred_norm * max_rul

    rmse = np.sqrt(mean_squared_error(y_test, y_pred))
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"  Transformer RUL - RMSE: {rmse:.2f} days, MAE: {mae:.2f} days, R2: {r2:.3f}")

    model_dir = os.path.join(MODELS_DIR, 'transformer-rul')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.keras'))

    mean = X_train.mean(axis=(0, 1))
    std = X_train.std(axis=(0, 1)) + 1e-8
    scaler_data = {"mean": mean.tolist(), "scale": std.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)

    metadata = {
        "name": "transformer-rul-predictor",
        "version": "3.0.0",
        "type": "keras",
        "task": "rul_prediction",
        "inputShape": [None, 30, 15],
        "seqLength": 30,
        "nFeatures": 15,
        "maxRul": max_rul,
        "features": generator.feature_names,
        "rmse": float(rmse),
        "mae": float(mae),
        "r2": float(r2),
        "architecture": {"d_model": d_model, "num_heads": num_heads, "ff_dim": ff_dim, "num_layers": num_layers},
        "description": "Transformer model for RUL prediction with self-attention",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_autoencoder_anomaly():
    """Train Autoencoder model for anomaly detection"""
    if not HAS_TF:
        print("Skipping Autoencoder - TensorFlow not available")
        return

    print("\n" + "="*60)
    print("Training Autoencoder Anomaly Detection Model")
    print("="*60)

    generator = RealisticIndustrialDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)
    X, y = generator.generate_multi_sensor_data(8000, n_sensors=5, anomaly_ratio=0.15)

    # Add 9 more features for 14 total
    X_extended = np.zeros((len(X), 14), dtype=np.float32)
    X_extended[:, :5] = X

    # Generate additional features
    for i in range(len(X)):
        X_extended[i, 5] = X[i, 0] * X[i, 2] + np.random.normal(0, 0.03)  # temp * pressure
        X_extended[i, 6] = X[i, 1] / (X[i, 3] + 0.1) + np.random.normal(0, 0.02)  # vibration/power
        X_extended[i, 7] = np.mean(X[i]) + np.random.normal(0, 0.02)  # mean
        X_extended[i, 8] = np.std(X[i]) + np.random.normal(0, 0.01)   # std
        X_extended[i, 9:14] = np.random.normal(0.5, 0.1, 5)  # spectral bands

        if y[i] == 1:  # Anomaly - disturb spectral bands
            X_extended[i, 9:14] += np.random.uniform(0.1, 0.3, 5)

    X_extended = np.clip(X_extended, 0, 1)

    # Train only on normal data
    X_normal = X_extended[y == 0]
    X_anomaly = X_extended[y == 1]

    X_train, X_test_normal = train_test_split(X_normal, test_size=0.2, random_state=42)

    # Autoencoder architecture
    input_dim = 14
    encoding_dim = 8

    encoder = keras.Sequential([
        keras.layers.Input(shape=(input_dim,)),
        keras.layers.Dense(32, activation='relu', kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dropout(0.3),
        keras.layers.Dense(16, activation='relu', kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.Dense(encoding_dim, activation='relu')
    ])

    decoder = keras.Sequential([
        keras.layers.Input(shape=(encoding_dim,)),
        keras.layers.Dense(16, activation='relu'),
        keras.layers.Dense(32, activation='relu'),
        keras.layers.Dense(input_dim, activation='sigmoid')
    ])

    inputs = keras.layers.Input(shape=(input_dim,))
    encoded = encoder(inputs)
    decoded = decoder(encoded)
    autoencoder = keras.Model(inputs, decoded)

    autoencoder.compile(optimizer=keras.optimizers.Adam(learning_rate=0.001), loss='mse')

    autoencoder.fit(X_train, X_train, epochs=50, batch_size=32,
                    validation_split=0.15, verbose=1,
                    callbacks=[keras.callbacks.EarlyStopping(patience=10, restore_best_weights=True)])

    # Calculate threshold from normal data
    reconstructions = autoencoder.predict(X_train, verbose=0)
    train_errors = np.mean(np.square(X_train - reconstructions), axis=1)
    threshold = np.percentile(train_errors, 95)  # 95th percentile

    # Evaluate
    test_normal_recon = autoencoder.predict(X_test_normal, verbose=0)
    test_anomaly_recon = autoencoder.predict(X_anomaly, verbose=0)

    normal_errors = np.mean(np.square(X_test_normal - test_normal_recon), axis=1)
    anomaly_errors = np.mean(np.square(X_anomaly - test_anomaly_recon), axis=1)

    # Classification accuracy
    normal_correct = np.sum(normal_errors < threshold)
    anomaly_correct = np.sum(anomaly_errors >= threshold)
    total_correct = normal_correct + anomaly_correct
    total_samples = len(X_test_normal) + len(X_anomaly)
    accuracy = total_correct / total_samples

    print(f"  Autoencoder - Threshold: {threshold:.4f}, Accuracy: {accuracy:.2%}")
    print(f"    Normal samples below threshold: {normal_correct}/{len(X_test_normal)}")
    print(f"    Anomaly samples above threshold: {anomaly_correct}/{len(X_anomaly)}")

    model_dir = os.path.join(MODELS_DIR, 'autoencoder-anomaly')
    os.makedirs(model_dir, exist_ok=True)
    autoencoder.save(os.path.join(model_dir, 'model.keras'))

    # Save scaler
    scaler = StandardScaler()
    scaler.fit(X_train)
    scaler_data = {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)

    metadata = {
        "name": "autoencoder-anomaly-detector",
        "version": "3.0.0",
        "type": "keras",
        "task": "anomaly_detection",
        "inputShape": [1, 14],
        "encodingDim": encoding_dim,
        "threshold": float(threshold),
        "accuracy": float(accuracy),
        "features": ["temp", "vibration", "pressure", "power", "flow",
                     "temp_pressure", "vib_power_ratio", "mean", "std",
                     "band_1", "band_2", "band_3", "band_4", "band_5"],
        "description": "Autoencoder for anomaly detection via reconstruction error",
        "usage": "Anomaly if reconstruction_error > threshold",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_cnn_classifier():
    """Train 1D-CNN model for fault classification"""
    if not HAS_TF:
        print("Skipping CNN Classifier - TensorFlow not available")
        return

    print("\n" + "="*60)
    print("Training CNN Fault Classifier Model")
    print("="*60)

    generator = FaultClassificationGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)
    X, y, classes = generator.generate_fault_data(n_samples=4000, n_features=13)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Apply SMOTE
    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')

    # Reshape for 1D CNN: (samples, features, 1)
    X_train_cnn = X_train_res.reshape(-1, 13, 1)
    X_test_cnn = X_test.reshape(-1, 13, 1)

    # CNN architecture
    model = keras.Sequential([
        keras.layers.Input(shape=(13, 1)),
        keras.layers.Conv1D(16, kernel_size=3, activation='relu', padding='same',
                           kernel_regularizer=keras.regularizers.l2(0.01)),
        keras.layers.MaxPooling1D(pool_size=2),
        keras.layers.Dropout(0.4),
        keras.layers.Conv1D(8, kernel_size=3, activation='relu', padding='same'),
        keras.layers.Flatten(),
        keras.layers.Dropout(0.5),
        keras.layers.Dense(16, activation='relu'),
        keras.layers.Dense(len(classes), activation='softmax')
    ])

    model.compile(optimizer=keras.optimizers.Adam(learning_rate=0.001),
                  loss='sparse_categorical_crossentropy', metrics=['accuracy'])

    model.fit(X_train_cnn, y_train_res, epochs=50, batch_size=32,
              validation_split=0.15, verbose=1,
              callbacks=[keras.callbacks.EarlyStopping(patience=10, restore_best_weights=True)])

    _, acc = model.evaluate(X_test_cnn, y_test, verbose=0)
    y_pred = model.predict(X_test_cnn, verbose=0).argmax(axis=1)

    print(f"  CNN Classifier - Accuracy: {acc:.2%}")
    print(classification_report(y_test, y_pred, target_names=classes))

    model_dir = os.path.join(MODELS_DIR, 'cnn-classifier')
    os.makedirs(model_dir, exist_ok=True)
    model.save(os.path.join(model_dir, 'model.keras'))

    # Save scaler
    scaler = StandardScaler()
    scaler.fit(X_train)
    scaler_data = {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)

    # Save label encoder
    le = LabelEncoder()
    le.fit(classes)
    joblib.dump(le, os.path.join(model_dir, 'label_encoder.joblib'))

    metadata = {
        "name": "cnn-fault-classifier",
        "version": "3.0.0",
        "type": "keras",
        "task": "classification",
        "inputShape": [1, 13],
        "classes": classes,
        "nClasses": len(classes),
        "accuracy": float(acc),
        "features": ["rms", "peak", "crest_factor", "kurtosis", "skewness",
                     "freq_1x", "freq_2x", "freq_3x", "harmonic_ratio",
                     "temperature", "current", "pressure", "efficiency"],
        "description": "1D-CNN for 4-class fault classification",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_isolation_forest_8sensor():
    """Train Isolation Forest model for 8-sensor anomaly detection"""
    if not HAS_SKLEARN:
        print("Skipping Isolation Forest - scikit-learn not available")
        return

    print("\n" + "="*60)
    print("Training Isolation Forest 8-Sensor Model")
    print("="*60)

    generator = RealisticIndustrialDataGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)
    X, y = generator.generate_8sensor_motor_data(8000, anomaly_ratio=0.20)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Train on normal data only (unsupervised)
    X_normal = X_train[y_train == 0]

    # Isolation Forest
    model = IsolationForest(
        n_estimators=100,
        max_samples=256,
        contamination=0.15,  # Expected anomaly rate
        random_state=42,
        n_jobs=-1
    )
    model.fit(X_normal)

    # Predict (-1 for anomaly, 1 for normal)
    y_pred_train = model.predict(X_train)
    y_pred_test = model.predict(X_test)

    # Convert to 0/1 (0=normal, 1=anomaly)
    y_pred_train = (y_pred_train == -1).astype(int)
    y_pred_test = (y_pred_test == -1).astype(int)

    acc = accuracy_score(y_test, y_pred_test)
    print(f"  Isolation Forest - Accuracy: {acc:.2%}")
    print(classification_report(y_test, y_pred_test, target_names=['Normal', 'Anomaly']))

    model_dir = os.path.join(MODELS_DIR, 'isolation-forest-8sensor')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(model, os.path.join(model_dir, 'model.joblib'))

    # Save scaler
    scaler = StandardScaler()
    scaler.fit(X_train)
    scaler_data = {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)
    joblib.dump(scaler, os.path.join(model_dir, 'scaler.joblib'))

    # Find examples
    normal_idx = np.where(y_test == 0)[0][0]
    anomaly_idx = np.where(y_test == 1)[0][0]

    metadata = {
        "name": "isolation-forest-8sensor",
        "version": "3.0.0",
        "type": "sklearn",
        "task": "anomaly_detection",
        "inputShape": [1, 8],
        "accuracy": float(acc),
        "contamination": 0.15,
        "nEstimators": 100,
        "features": ["temp", "vibration", "pressure", "power", "speed", "flow", "current", "humidity"],
        "normalExample": X_test[normal_idx].tolist(),
        "anomalyExample": X_test[anomaly_idx].tolist(),
        "description": "Isolation Forest for 8-sensor motor/pump anomaly detection",
        "output": "decision_function returns anomaly score (negative = anomaly)",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_xgboost_classifier():
    """Train XGBoost model for fault classification"""
    if not HAS_XGBOOST:
        print("Skipping XGBoost - XGBoost not available")
        return
    if not HAS_SKLEARN:
        print("Skipping XGBoost - scikit-learn not available")
        return

    print("\n" + "="*60)
    print("Training XGBoost Fault Classifier Model")
    print("="*60)

    generator = FaultClassificationGenerator(seed=42, overlap_ratio=OVERLAP_RATIO)

    # Use 8 features for simpler model
    X_full, y, classes = generator.generate_fault_data(n_samples=4000, n_features=13)
    X = X_full[:, :8]  # Take first 8 features

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # Apply SMOTE
    X_train_res, y_train_res = apply_resampling(X_train, y_train, 'smote')

    # XGBoost with regularization for realistic outputs
    model = XGBClassifier(
        n_estimators=50,
        max_depth=4,
        learning_rate=0.1,
        reg_alpha=0.1,  # L1 regularization
        reg_lambda=1.0,  # L2 regularization
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        use_label_encoder=False,
        eval_metric='mlogloss'
    )
    model.fit(X_train_res, y_train_res)

    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)
    acc = accuracy_score(y_test, y_pred)

    print(f"  XGBoost Classifier - Accuracy: {acc:.2%}")
    print(classification_report(y_test, y_pred, target_names=classes))

    model_dir = os.path.join(MODELS_DIR, 'xgboost-classifier')
    os.makedirs(model_dir, exist_ok=True)
    joblib.dump(model, os.path.join(model_dir, 'model.joblib'))

    # Save scaler
    scaler = StandardScaler()
    scaler.fit(X_train)
    scaler_data = {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()}
    with open(os.path.join(model_dir, 'scaler.json'), 'w') as f:
        json.dump(scaler_data, f, indent=2)
    joblib.dump(scaler, os.path.join(model_dir, 'scaler.joblib'))

    # Save label encoder
    le = LabelEncoder()
    le.fit(classes)
    joblib.dump(le, os.path.join(model_dir, 'label_encoder.joblib'))

    # Find examples per class
    examples = {}
    for i, cls in enumerate(classes):
        idx = np.where(y_test == i)[0]
        if len(idx) > 0:
            examples[cls] = X_test[idx[0]].tolist()

    metadata = {
        "name": "xgboost-fault-classifier",
        "version": "3.0.0",
        "type": "sklearn",
        "task": "classification",
        "inputShape": [1, 8],
        "classes": classes,
        "nClasses": len(classes),
        "accuracy": float(acc),
        "features": ["rms", "peak", "crest_factor", "kurtosis", "skewness",
                     "freq_1x", "freq_2x", "freq_3x"],
        "examples": examples,
        "description": "XGBoost for 4-class fault classification",
        "realisticTraining": True,
        "createdAt": datetime.now().isoformat()
    }
    with open(os.path.join(model_dir, 'metadata.json'), 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f"  Saved to {model_dir}")
    return model_dir


def train_new_models():
    """Train all 7 new model types"""
    print("\n" + "="*60)
    print("TRAINING NEW MODEL TYPES")
    print("="*60)

    # Environment variable control
    train_lstm = os.environ.get('TRAIN_LSTM', 'true').lower() == 'true'
    train_cnn_lstm = os.environ.get('TRAIN_CNN_LSTM', 'true').lower() == 'true'
    train_transformer = os.environ.get('TRAIN_TRANSFORMER', 'true').lower() == 'true'
    train_autoencoder = os.environ.get('TRAIN_AUTOENCODER', 'true').lower() == 'true'
    train_cnn = os.environ.get('TRAIN_CNN', 'true').lower() == 'true'
    train_iforest = os.environ.get('TRAIN_ISOLATION_FOREST', 'true').lower() == 'true'
    train_xgb = os.environ.get('TRAIN_XGBOOST', 'true').lower() == 'true'

    if train_lstm:
        train_lstm_rul()
    if train_cnn_lstm:
        train_cnn_lstm_rul()
    if train_transformer:
        train_transformer_rul()
    if train_autoencoder:
        train_autoencoder_anomaly()
    if train_cnn:
        train_cnn_classifier()
    if train_iforest:
        train_isolation_forest_8sensor()
    if train_xgb:
        train_xgboost_classifier()

    print("\n" + "="*60)
    print("ALL NEW MODELS TRAINED!")
    print("="*60)


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
    print(f"imbalanced-learn available: {HAS_IMBLEARN}")
    print(f"XGBoost available: {HAS_XGBOOST}")
    print(f"\nConfiguration:")
    print(f"  SMOTE enabled: {SMOTE_ENABLED}")
    print(f"  Overlap ratio: {OVERLAP_RATIO}")
    print(f"  Imbalance ratio: {IMBALANCE_RATIO}")

    # Train all models
    train_onnx_models()
    train_keras_models()
    train_tflite_model()
    train_sklearn_models()
    train_usecase_models()
    train_new_models()  # Train 7 new model types

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
                roc = meta.get('rocAuc', meta.get('roc_auc', 'N/A'))
                if isinstance(acc, float):
                    acc = f"{acc:.2%}"
                if isinstance(roc, float):
                    roc = f"{roc:.3f}"
                print(f"  {item}: Acc={acc}, ROC-AUC={roc}")

    print("\n" + "="*60)
    print("Expected behavior with new models:")
    print("="*60)
    print("  Normal input:     Score 0.15-0.30")
    print("  Borderline input: Score 0.40-0.60")
    print("  Clear anomaly:    Score 0.70-0.90")
    print("\nExample inputs for 8-sensor model:")
    print("  Normal:     [0.45, 0.25, 0.55, 0.50, 0.60, 0.55, 0.45, 0.40]")
    print("  Borderline: [0.58, 0.42, 0.48, 0.58, 0.52, 0.48, 0.55, 0.42]")
    print("  Bearing:    [0.72, 0.82, 0.55, 0.55, 0.58, 0.53, 0.62, 0.40]")
    print("  Overload:   [0.78, 0.45, 0.50, 0.85, 0.30, 0.45, 0.88, 0.40]")
    print("  Cavitation: [0.62, 0.75, 0.12, 0.55, 0.58, 0.25, 0.50, 0.40]")


if __name__ == '__main__':
    main()
