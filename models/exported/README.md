
# Exportierte Modelle für Node-RED

Diese Modelle können mit dem **ML Inference Node** in Node-RED verwendet werden.

## Verfügbare Modelle

### 1. Anomalie-Erkennung

**Isolation Forest** (ONNX)
- Datei: `isolation_forest.onnx`
- Metadata: `isolation_forest_metadata.json`
- Input: Array von Features (normalisiert)
- Output: Anomalie-Score (-1 = Anomalie, 1 = Normal)

```javascript
// Beispiel: Input für ML Inference Node
msg.payload = [0.5, 1.2, 0.8, 3.1, ...]; // Features
```

**Autoencoder** (TensorFlow.js)
- Verzeichnis: `autoencoder_tfjs/`
- Input: Array von Features (normalisiert)
- Output: Rekonstruktion (vergleiche mit Input für Anomalie-Score)

### 2. Fehlerklassifikation

**Random Forest Classifier** (ONNX)
- Datei: `random_forest_classifier.onnx`
- Klassen: normal, unbalance, bearing, misalignment
- Output: Wahrscheinlichkeiten pro Klasse

**MLP Classifier** (TensorFlow.js)
- Verzeichnis: `mlp_classifier_tfjs/`
- Klassen: normal, unbalance, bearing, misalignment

### 3. RUL Prediction

**Gradient Boosting** (ONNX)
- Datei: `rul_gradient_boosting.onnx`
- Input: Einzelnes Feature-Array
- Output: RUL in Zyklen (0-125)

**LSTM** (TensorFlow.js)
- Verzeichnis: `rul_lstm_tfjs/`
- Input: Sequenz von 30 Zeitschritten
- Output: RUL in Zyklen

## Node-RED Konfiguration

### ML Inference Node

1. **Model Path**: Pfad zum Modell (`.onnx` oder `model.json`)
2. **Model Type**: `onnx` oder `tensorflow`
3. **Input Property**: `msg.payload`
4. **Output Property**: `msg.prediction`

### Preprocessing

Die Modelle erwarten normalisierte Eingaben. Verwende die Scaler-Parameter:

```javascript
// In einer Function Node vor ML Inference
const mean = [...]; // Aus metadata.json
const scale = [...]; // Aus metadata.json

msg.payload = msg.payload.map((val, i) => (val - mean[i]) / scale[i]);
return msg;
```

### Beispiel Flow

```
[Sensor Input] -> [Feature Extraction] -> [Normalize] -> [ML Inference] -> [Postprocess] -> [Output]
```

## Dateien

| Datei | Format | Verwendung |
|-------|--------|------------|
| `*.onnx` | ONNX | ML Inference mit onnxruntime |
| `*_tfjs/model.json` | TensorFlow.js | ML Inference mit @tensorflow/tfjs |
| `*_metadata.json` | JSON | Preprocessing & Konfiguration |
