# Jupyter Notebooks for Predictive Maintenance

These notebooks enable training of ML models for Condition Monitoring and Predictive Maintenance.

## Directory Structure

```
notebooks/
├── python/                          # Python-based notebooks (TensorFlow, scikit-learn)
│   ├── 01_data_simulation.ipynb
│   ├── 01_data_simulation_interactive.ipynb
│   ├── 02_anomaly_detection.ipynb
│   ├── 03_rul_prediction.ipynb
│   ├── 04_classification.ipynb
│   ├── 05_model_export.ipynb
│   ├── 06_transformer_models.ipynb
│   ├── 07_mamba_models.ipynb
│   ├── 08_graph_neural_networks.ipynb
│   ├── 09_diffusion_models.ipynb
│   ├── 10_hybrid_frameworks.ipynb
│   ├── usecase_01_pump_monitoring.ipynb
│   ├── usecase_02_electric_motor.ipynb
│   ├── usecase_03_bearing_rul.ipynb
│   ├── usecase_04_hvac_system.ipynb
│   ├── usecase_05_cnc_tool_wear.ipynb
│   └── test_notebooks.py
│
├── mojo/                            # Mojo-based notebooks (high-performance)
│   └── 11_mojo_introduction.ipynb
│
└── README.md
```

---

## Python Notebooks (`python/`)

### Core Training Notebooks

| Notebook | Description | Output |
|----------|-------------|--------|
| `01_data_simulation.ipynb` | Generates realistic sensor data | CSV files in `data/simulated/` |
| `01_data_simulation_interactive.ipynb` | Interactive UI for data generation | CSV, JSON (7 formats) |
| `02_anomaly_detection.ipynb` | Trains anomaly detection models | Isolation Forest, Autoencoder |
| `03_rul_prediction.ipynb` | Trains RUL prediction models | LSTM, CNN-LSTM, Gradient Boosting |
| `04_classification.ipynb` | Trains fault classifiers | Random Forest, XGBoost, CNN |
| `05_model_export.ipynb` | Exports models for Node-RED | ONNX, TensorFlow.js |
| `06_transformer_models.ipynb` | Transformer-based models | RUL, Classification, Anomaly Detection |

### Advanced Model Notebooks (State-of-the-Art 2025/2026)

| Notebook | Model Type | Key Innovation | Use Case |
|----------|------------|----------------|----------|
| `07_mamba_models.ipynb` | Mamba (Selective SSM) | O(n) complexity, long sequences | Long-term degradation, edge deployment |
| `08_graph_neural_networks.ipynb` | GNN / GAT | Sensor network relationships | Multi-sensor systems, factories |
| `09_diffusion_models.ipynb` | Denoising Diffusion | Synthetic fault generation | Few-shot learning, data augmentation |
| `10_hybrid_frameworks.ipynb` | FNO + Ensemble + RL | Physics-informed + decision optimization | Complex systems, maintenance scheduling |

### Industry Use Case Notebooks

| Notebook | Industry | Sensors | ML Tasks |
|----------|----------|---------|----------|
| `usecase_01_pump_monitoring.ipynb` | Chemical / Water | Vibration, pressure, flow, temperature | Anomaly detection, fault classification |
| `usecase_02_electric_motor.ipynb` | Manufacturing | Current, vibration, temperature | MCSA, fault detection, health index |
| `usecase_03_bearing_rul.ipynb` | Wind / Rotating machinery | Vibration, temperature, oil debris | RUL prediction (GB, LSTM) |
| `usecase_04_hvac_system.ipynb` | Building automation | Temperature, pressure, airflow | Fault detection, energy waste |
| `usecase_05_cnc_tool_wear.ipynb` | Machining | Force, vibration, current, AE | Wear prediction, RTL estimation |

### Python Requirements

```bash
# Core dependencies
pip install numpy pandas matplotlib scikit-learn scipy

# Deep Learning
pip install tensorflow tensorflowjs

# Additional ML
pip install xgboost lightgbm

# Model export
pip install onnx skl2onnx tf2onnx

# Interactive widgets
pip install ipywidgets

# Visualization
pip install seaborn jupyter
```

---

## Mojo Notebooks (`mojo/`)

| Notebook | Description | Use Case |
|----------|-------------|----------|
| `11_mojo_introduction.ipynb` | Introduction to Mojo for PM/CM | Edge deployment, real-time processing |

### Why Mojo?

| Advantage | Description |
|-----------|-------------|
| **Performance** | Up to 35,000x faster than Python for compute-intensive tasks |
| **Python Syntax** | Familiar syntax, easy learning curve |
| **Edge Deployment** | Optimized for real-time inference on ARM/embedded systems |
| **SIMD Support** | Native vectorization for signal processing |
| **MAX Engine** | High-performance ONNX inference |

### Mojo Requirements

```bash
# Install Mojo (requires Linux/macOS/WSL)
curl -fsSL https://pixi.sh/install.sh | sh
pixi init mojo-project -c https://conda.modular.com/max-nightly/ -c conda-forge
cd mojo-project
pixi add mojo jupyterlab
pixi shell
jupyter lab
```

> **Note:** Mojo notebooks use `%%mojo` cell magic. Python notebooks work with standard Jupyter.

---

## Execution Order

### Python Notebooks

```
python/01_data_simulation.ipynb           # First: Generates training data
python/01_data_simulation_interactive.ipynb  # Alternative: Interactive UI
        ↓
python/02_anomaly_detection.ipynb         # Trains anomaly models
python/03_rul_prediction.ipynb            # Trains RUL models (LSTM, Gradient Boosting)
python/04_classification.ipynb            # Trains classification models
python/06_transformer_models.ipynb        # Advanced: Transformer-based models
python/07_mamba_models.ipynb              # State Space Models (long sequences)
python/08_graph_neural_networks.ipynb     # GNN for multi-sensor systems
python/09_diffusion_models.ipynb          # Diffusion for anomaly detection & data augmentation
python/10_hybrid_frameworks.ipynb         # FNO, Ensemble, RL for complex systems
        ↓
python/05_model_export.ipynb              # Last: Exports all models to ONNX
```

### Use Case Notebooks (Independent)

Each use case notebook is self-contained:

```
python/usecase_01_pump_monitoring.ipynb     # Centrifugal pump monitoring
python/usecase_02_electric_motor.ipynb      # Induction motor diagnostics
python/usecase_03_bearing_rul.ipynb         # Bearing life prediction
python/usecase_04_hvac_system.ipynb         # HVAC fault detection
python/usecase_05_cnc_tool_wear.ipynb       # CNC tool wear monitoring
```

### Mojo Notebooks (Optional - for Edge Deployment)

```
mojo/11_mojo_introduction.ipynb           # Learn Mojo basics, deploy to edge
```

---

## Data & Models Directory Structure

```
data/
├── simulated/              # Generic simulation data
├── usecase_pump/           # Pump monitoring data
├── usecase_motor/          # Motor monitoring data
├── usecase_bearing/        # Bearing RUL data
├── usecase_hvac/           # HVAC system data
└── usecase_cnc/            # CNC tool wear data

models/
├── trained/                # Trained models (generic)
├── exported/               # Exported for Node-RED (ONNX, TF.js)
├── transformer/            # Transformer-based models
├── mamba/                  # Mamba/SSM models
├── gnn/                    # Graph Neural Network models
├── diffusion/              # Diffusion models
├── hybrid/                 # Hybrid framework models
├── usecase_pump/           # Pump models
├── usecase_motor/          # Motor models
├── usecase_bearing/        # Bearing models
├── usecase_hvac/           # HVAC models
└── usecase_cnc/            # CNC models
```

---

## Node-RED Integration

All notebooks include Node-RED integration examples showing how to:
1. Collect sensor data
2. Calculate derived features
3. Build feature arrays
4. Use ML Inference Node
5. Interpret predictions
6. Trigger alerts

### Training Data Collection

Use the **Training Data Collector** node to collect data directly from Node-RED:

```
[Sensor Input] → [Multi-Value Processor] → [Training Data Collector] → [Export]
```

The Training Data Collector supports:
- **CSV export** - Compatible with `pd.read_csv()`
- **JSONL export** - Compatible with HuggingFace datasets
- **JSON export** - Structured format with metadata
- **S3 upload** - Direct cloud storage
- **Auto-splitting** - Train/val/test splits

### Inference Flow Pattern

```
[Sensor Input] → [Feature Extraction] → [ML Inference] → [Alert Logic] → [Dashboard/Action]
```

---

## Model Export Formats

| Format | Use Case | Node-RED Support |
|--------|----------|------------------|
| ONNX | Cross-platform inference | onnxruntime-node |
| TensorFlow.js | Browser/Node.js | tfjs-node |
| joblib | Python backend | Flask/FastAPI |
| Keras | TensorFlow Serving | REST API |

---

## Framework Comparison

| Aspect | Python (TensorFlow) | Mojo (MAX) |
|--------|---------------------|------------|
| **Training** | ✅ Full support | ❌ Not yet |
| **Inference Speed** | Good | ✅ Excellent |
| **Edge Deployment** | ⚠️ Limited | ✅ Optimized |
| **Ecosystem** | ✅ Mature | ⚠️ Growing |
| **ONNX Support** | ✅ Export & Import | ✅ Import only |
| **Learning Curve** | ✅ Easy | ✅ Easy (Python-like) |

**Recommended Workflow**:
1. **Train** models in Python (TensorFlow/PyTorch) → `python/` notebooks
2. **Export** to ONNX format → `python/05_model_export.ipynb`
3. **Deploy** with MAX Engine (Mojo) for edge → `mojo/11_mojo_introduction.ipynb`

---

## Advanced Model Details

### 7. Mamba (Selective State Space Models)

**Architecture**: Selective SSM with input-dependent parameters

**Advantages**:
- O(n) complexity vs O(n²) for Transformers
- Efficient for very long sequences (1000+ timesteps)
- Memory efficient for edge deployment

**Best For**: Long-term degradation monitoring, real-time streaming

### 8. Graph Neural Networks

**Architecture**: GCN, GAT with multi-head attention

**Advantages**:
- Models sensor relationships explicitly
- Distinguishes sensor faults from system faults
- Scalable to varying network sizes

**Best For**: Multi-sensor systems, factory monitoring, sensor networks

### 9. Diffusion Models

**Architecture**: Denoising Diffusion Probabilistic Models

**Advantages**:
- High-quality synthetic fault generation
- Anomaly detection via reconstruction
- Works with limited labeled data

**Best For**: Few-shot learning, data augmentation, missing data imputation

### 10. Hybrid Frameworks

**Components**:
- **FNO**: Fourier Neural Operators for frequency analysis
- **Ensemble**: VAE + LSTM + Transformer combination
- **RL**: DQN for maintenance scheduling optimization
- **Multi-Modal**: Cross-attention sensor fusion

**Best For**: Complex systems requiring multiple analysis approaches

### 11. Mojo / MAX Engine

**Architecture**: High-performance compiled language with SIMD

**Advantages**:
- Native performance (up to 35,000x faster than Python)
- Python-like syntax
- ARM64 support for edge devices
- ONNX model inference via MAX Engine

**Best For**: Edge deployment, real-time inference, embedded systems

---

## Use Case Details

### 1. Pump Monitoring

**Scenario**: Chemical plant centrifugal pumps

**Faults Detected**: Cavitation, Seal leakage, Bearing damage, Impeller wear

**Key Features**: `vibration_rms`, `efficiency`, `npsh_margin`, `filter_dp`

### 2. Electric Motor Monitoring

**Scenario**: Manufacturing plant induction motors

**Faults Detected**: Broken rotor bars, Stator faults, Eccentricity, Bearing faults, Misalignment, Unbalance

**Key Features**: `current_imbalance`, `THD`, `vib_rms`, `sideband_amplitude`

### 3. Bearing RUL Prediction

**Scenario**: Wind turbine gearbox bearings

**Predictions**: Remaining Useful Life (days), Degradation stage, Health index

**Key Features**: `kurtosis`, `debris_count`, `defect_freq_amp`, `hf_energy`

### 4. HVAC System Monitoring

**Scenario**: Commercial building AHU

**Faults Detected**: Clogged filter, Fan belt wear, Refrigerant leak, Stuck damper

**Key Features**: `filter_dp`, `fan_vibration`, `economizer_eff`, `specific_fan_power`

### 5. CNC Tool Wear

**Scenario**: Precision machining center

**Predictions**: Flank wear (VB in mm), Remaining tool life (minutes), Wear state

**Key Features**: `force_resultant`, `vibration_rms`, `ae_rms`, `specific_energy`

---

## Tips for Best Results

1. **Data Quality**: Ensure clean, labeled data for supervised learning
2. **Feature Engineering**: Domain-specific features improve accuracy
3. **Cross-Validation**: Use proper train/test splits by unit/equipment
4. **Threshold Tuning**: Adjust thresholds based on cost of false positives/negatives
5. **Continuous Learning**: Retrain models periodically with new data
6. **Model Selection**: Choose based on sequence length, sensor relationships, and deployment constraints
7. **Edge Deployment**: Use Mojo/MAX for real-time requirements on embedded systems
