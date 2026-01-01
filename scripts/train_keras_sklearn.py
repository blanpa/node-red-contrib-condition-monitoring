#!/usr/bin/env python3
"""
Train Keras and scikit-learn models for Node-RED Condition Monitoring

This script creates:
1. Keras model (.keras) - Neural network for anomaly detection
2. Keras legacy model (.h5) - Same model in HDF5 format
3. scikit-learn Random Forest (.pkl) - Classic ML classifier
4. scikit-learn model with joblib (.joblib) - Gradient Boosting
"""

import os
import json
import numpy as np

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, 'models')

print("="*70)
print("Training Keras and scikit-learn Models")
print("="*70)


def generate_sensor_data(n_samples=5000, n_features=6):
    """Generate synthetic sensor data for classification."""
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
        
        if anomaly_type == 0:
            idx = np.random.randint(0, n_features)
            base[idx] = np.random.uniform(0.85, 1.0)
        elif anomaly_type == 1:
            idx = np.random.randint(0, n_features)
            base[idx] = np.random.uniform(0.0, 0.15)
        else:
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
# 1. Keras Models (.keras and .h5)
# ============================================================

def train_keras_models():
    """Train and save Keras models."""
    print("\n" + "-"*50)
    print("📦 Training Keras Models")
    print("-"*50)
    
    try:
        import tensorflow as tf
        from tensorflow import keras
        print(f"TensorFlow version: {tf.__version__}")
    except ImportError:
        print("❌ TensorFlow not installed. Skipping Keras models.")
        return
    
    tf.random.set_seed(42)
    
    X, y = generate_sensor_data(n_samples=6000, n_features=6)
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"Training samples: {len(X_train)}")
    print(f"Test samples: {len(X_test)}")
    
    # Build model
    model = keras.Sequential([
        keras.layers.Input(shape=(6,)),
        keras.layers.Dense(32, activation='relu'),
        keras.layers.Dropout(0.2),
        keras.layers.Dense(16, activation='relu'),
        keras.layers.Dropout(0.1),
        keras.layers.Dense(1, activation='sigmoid')
    ])
    
    model.compile(
        optimizer='adam',
        loss='binary_crossentropy',
        metrics=['accuracy']
    )
    
    print("\nTraining...")
    model.fit(X_train, y_train, epochs=20, batch_size=64, 
              validation_split=0.2, verbose=0)
    
    # Evaluate
    results = model.evaluate(X_test, y_test, verbose=0)
    print(f"Test Accuracy: {results[1]:.4f}")
    
    # Save as .keras (new format)
    keras_dir = os.path.join(MODELS_DIR, 'keras-anomaly')
    os.makedirs(keras_dir, exist_ok=True)
    
    keras_path = os.path.join(keras_dir, 'model.keras')
    model.save(keras_path)
    print(f"✓ Saved: {keras_path}")
    
    # Save as .h5 (legacy format)
    h5_dir = os.path.join(MODELS_DIR, 'keras-h5-anomaly')
    os.makedirs(h5_dir, exist_ok=True)
    
    h5_path = os.path.join(h5_dir, 'model.h5')
    model.save(h5_path)
    print(f"✓ Saved: {h5_path}")
    
    # Metadata
    for dir_path, model_file in [(keras_dir, 'model.keras'), (h5_dir, 'model.h5')]:
        with open(os.path.join(dir_path, 'metadata.json'), 'w') as f:
            json.dump({
                'format': 'keras',
                'file': model_file,
                'framework': 'TensorFlow/Keras',
                'tf_version': tf.__version__,
                'input_shape': [6],
                'features': ['sensor_1', 'sensor_2', 'sensor_3', 'sensor_4', 'sensor_5', 'sensor_6'],
                'output': 'anomaly_probability',
                'accuracy': float(results[1]),
                'description': 'Keras neural network for 6-sensor anomaly detection'
            }, f, indent=2)
    
    return model


# ============================================================
# 2. scikit-learn Models (.pkl and .joblib)
# ============================================================

def train_sklearn_models():
    """Train and save scikit-learn models."""
    print("\n" + "-"*50)
    print("📦 Training scikit-learn Models")
    print("-"*50)
    
    try:
        from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import accuracy_score
        import pickle
        import joblib
        import sklearn
        print(f"scikit-learn version: {sklearn.__version__}")
    except ImportError:
        print("❌ scikit-learn not installed. Skipping sklearn models.")
        return
    
    X, y = generate_sensor_data(n_samples=6000, n_features=6)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    print(f"Training samples: {len(X_train)}")
    print(f"Test samples: {len(X_test)}")
    
    # 1. Random Forest (.pkl)
    print("\nTraining Random Forest...")
    rf_model = RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        random_state=42,
        n_jobs=-1
    )
    rf_model.fit(X_train, y_train)
    
    rf_acc = accuracy_score(y_test, rf_model.predict(X_test))
    print(f"Random Forest Accuracy: {rf_acc:.4f}")
    
    # Save with pickle
    rf_dir = os.path.join(MODELS_DIR, 'sklearn-rf')
    os.makedirs(rf_dir, exist_ok=True)
    
    rf_path = os.path.join(rf_dir, 'model.pkl')
    with open(rf_path, 'wb') as f:
        pickle.dump(rf_model, f)
    print(f"✓ Saved: {rf_path}")
    
    # Metadata
    with open(os.path.join(rf_dir, 'metadata.json'), 'w') as f:
        json.dump({
            'format': 'pickle',
            'file': 'model.pkl',
            'framework': 'scikit-learn',
            'model_type': 'RandomForestClassifier',
            'input_shape': [6],
            'features': ['sensor_1', 'sensor_2', 'sensor_3', 'sensor_4', 'sensor_5', 'sensor_6'],
            'output': 'class_probabilities',
            'classes': ['normal', 'anomaly'],
            'accuracy': float(rf_acc),
            'n_estimators': 100,
            'max_depth': 10,
            'description': 'Random Forest classifier for sensor anomaly detection'
        }, f, indent=2)
    
    # 2. Gradient Boosting (.joblib)
    print("\nTraining Gradient Boosting...")
    gb_model = GradientBoostingClassifier(
        n_estimators=100,
        max_depth=5,
        learning_rate=0.1,
        random_state=42
    )
    gb_model.fit(X_train, y_train)
    
    gb_acc = accuracy_score(y_test, gb_model.predict(X_test))
    print(f"Gradient Boosting Accuracy: {gb_acc:.4f}")
    
    # Save with joblib
    gb_dir = os.path.join(MODELS_DIR, 'sklearn-gb')
    os.makedirs(gb_dir, exist_ok=True)
    
    gb_path = os.path.join(gb_dir, 'model.joblib')
    joblib.dump(gb_model, gb_path)
    print(f"✓ Saved: {gb_path}")
    
    # Metadata
    with open(os.path.join(gb_dir, 'metadata.json'), 'w') as f:
        json.dump({
            'format': 'joblib',
            'file': 'model.joblib',
            'framework': 'scikit-learn',
            'model_type': 'GradientBoostingClassifier',
            'input_shape': [6],
            'features': ['sensor_1', 'sensor_2', 'sensor_3', 'sensor_4', 'sensor_5', 'sensor_6'],
            'output': 'class_probabilities',
            'classes': ['normal', 'anomaly'],
            'accuracy': float(gb_acc),
            'n_estimators': 100,
            'max_depth': 5,
            'learning_rate': 0.1,
            'description': 'Gradient Boosting classifier for sensor anomaly detection'
        }, f, indent=2)
    
    return rf_model, gb_model


# ============================================================
# Main
# ============================================================

if __name__ == '__main__':
    train_keras_models()
    train_sklearn_models()
    
    print("\n" + "="*70)
    print("✅ All models trained successfully!")
    print("="*70)
    
    print("""
📋 Created Models:

Keras Models:
  - /data/models/keras-anomaly/model.keras     (Keras 3 format)
  - /data/models/keras-h5-anomaly/model.h5     (HDF5 legacy format)

scikit-learn Models:
  - /data/models/sklearn-rf/model.pkl          (Random Forest, pickle)
  - /data/models/sklearn-gb/model.joblib       (Gradient Boosting, joblib)

Usage in Node-RED:
  - Model Type: Keras (.keras, .h5) or scikit-learn (.pkl, .joblib)
  - Input: 6 normalized sensor values [0-1]
  
Example input:
  msg.payload = [0.45, 0.52, 0.48, 0.55, 0.42, 0.58];
""")
