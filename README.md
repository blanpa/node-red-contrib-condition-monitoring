# node-red-contrib-condition-monitoring

Ein Node-RED Modul für Anomalieerkennung und Zeitreihenanalyse mit verschiedenen Erkennungsmethoden.

## Installation

```bash
npm install node-red-contrib-condition-monitoring
```

Oder für die Entwicklung:

```bash
cd node-red-contrib-condition-monitoring
npm install
```

## Verfügbare Nodes

### 1. Z-Score Anomalieerkennung

Erkennt Anomalien basierend auf dem Z-Score-Verfahren (Standardabweichung vom Mittelwert).

**Eigenschaften:**
- **Schwellenwert**: Anzahl der Standardabweichungen vom Mittelwert (Standard: 3.0)
- **Fenstergröße**: Anzahl der Werte für die Berechnung (Standard: 100)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (zScore, mean, stdDev, isAnomaly)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 42.5,
  "zScore": 3.2,
  "mean": 35.0,
  "stdDev": 2.3,
  "isAnomaly": true,
  "threshold": 3.0
}
```

### 2. IQR (Interquartile Range) Anomalieerkennung

Erkennt Anomalien basierend auf dem Interquartile Range Verfahren (Box-Plot Methode).

**Eigenschaften:**
- **Multiplikator**: Faktor für die IQR-Berechnung (Standard: 1.5)
- **Fenstergröße**: Anzahl der Werte für die Quartilberechnung (Standard: 100, mindestens 4)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (q1, q3, iqr, lowerBound, upperBound, isAnomaly)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 150.0,
  "q1": 100.0,
  "q3": 120.0,
  "iqr": 20.0,
  "lowerBound": 70.0,
  "upperBound": 150.0,
  "isAnomaly": true,
  "multiplier": 1.5
}
```

### 3. Moving Average Anomalieerkennung

Erkennt Anomalien basierend auf einem gleitenden Durchschnitt.

**Eigenschaften:**
- **Fenstergröße**: Anzahl der Werte für den gleitenden Durchschnitt (Standard: 10)
- **Methode**: 
  - `stddev`: Standardabweichung (Standard)
  - `percentage`: Prozentuale Abweichung
- **Schwellenwert**: Abhängig von der gewählten Methode (Standard: 2.0)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (movingAverage, deviation, deviationPercent, isAnomaly)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 45.0,
  "movingAverage": 35.0,
  "deviation": 10.0,
  "deviationPercent": 28.6,
  "isAnomaly": true,
  "method": "stddev",
  "threshold": 2.0
}
```

### 4. Isolation Forest Anomalieerkennung

Erkennt Anomalien mit einem Machine-Learning-Algorithmus (Isolation Forest).

**Eigenschaften:**
- **Kontamination**: Erwarteter Anteil der Anomalien (0.0 - 0.5, Standard: 0.1)
- **Fenstergröße**: Anzahl der Werte für das Training (Standard: 100, mindestens 10)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (isAnomaly, anomalyScore, method)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 42.5,
  "isAnomaly": true,
  "anomalyScore": -0.85,
  "method": "isolation-forest",
  "contamination": 0.1
}
```

**Hinweis:** Erfordert das npm-Paket `ml-isolation-forest`. Falls nicht verfügbar, wird automatisch eine Z-Score Fallback-Methode verwendet.

### 5. Threshold Anomalieerkennung

Einfache statische Schwellenwertprüfung mit Min/Max-Grenzen.

**Eigenschaften:**
- **Minimum-Schwellenwert**: Untere Grenze (optional, leer lassen zum Deaktivieren)
- **Maximum-Schwellenwert**: Obere Grenze (optional, leer lassen zum Deaktivieren)
- **Inklusiv**: Wenn aktiviert, gelten Werte genau an der Grenze als Anomalien

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten
- Ausgang 2: Anomalien mit Metadaten (reason, minThreshold, maxThreshold)

**Beispiel:**
```json
{
  "payload": 150.0,
  "isAnomaly": true,
  "minThreshold": 10.0,
  "maxThreshold": 100.0,
  "reason": "Über Maximum-Schwellenwert",
  "method": "threshold"
}
```

### 6. Percentile Anomalieerkennung

Erkennt Anomalien basierend auf konfigurierbaren Perzentilen (ähnlich IQR, aber flexibler).

**Eigenschaften:**
- **Unteres Perzentil**: Untere Grenze in Prozent (Standard: 5.0)
- **Oberes Perzentil**: Obere Grenze in Prozent (Standard: 95.0)
- **Fenstergröße**: Anzahl der Werte für die Perzentilberechnung (Standard: 100)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (lowerPercentile, upperPercentile, lowerBound, upperBound)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 150.0,
  "lowerPercentile": 5.0,
  "upperPercentile": 95.0,
  "lowerBound": 70.0,
  "upperBound": 150.0,
  "isAnomaly": true,
  "method": "percentile"
}
```

### 7. EMA (Exponential Moving Average) Anomalieerkennung

Erkennt Anomalien basierend auf einem exponentiell gewichteten gleitenden Durchschnitt.

**Eigenschaften:**
- **Alpha**: Gewichtung für neue Werte (0.0-1.0, Standard: 0.3)
- **Methode**: 
  - `stddev`: Standardabweichung (Standard)
  - `percentage`: Prozentuale Abweichung
- **Schwellenwert**: Abhängig von der gewählten Methode (Standard: 2.0)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (ema, deviation, deviationPercent, isAnomaly)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 45.0,
  "ema": 35.0,
  "deviation": 10.0,
  "deviationPercent": 28.6,
  "isAnomaly": true,
  "method": "ema-stddev",
  "alpha": 0.3,
  "threshold": 2.0
}
```

**Vorteil:** Reagiert schneller auf Änderungen als einfacher Moving Average, da neuere Werte mehr Gewicht haben.

### 8. CUSUM (Cumulative Sum) Anomalieerkennung

Erkennt schrittweise Änderungen und Drifts durch Akkumulation kleiner Abweichungen.

**Eigenschaften:**
- **Zielwert**: Erwarteter Wert (optional, leer lassen für automatischen Mittelwert)
- **Schwellenwert**: Grenze für die kumulative Summe (Standard: 5.0)
- **Drift**: Toleranz für kleine Abweichungen (Standard: 0.5)
- **Fenstergröße**: Anzahl der Werte für automatische Mittelwertberechnung (Standard: 100)

**Ausgaben:**
- Ausgang 1: Normale Werte mit Metadaten (target, cusumPos, cusumNeg, deviation)
- Ausgang 2: Anomalien mit Metadaten

**Beispiel:**
```json
{
  "payload": 42.5,
  "target": 35.0,
  "cusumPos": 5.2,
  "cusumNeg": 0.0,
  "deviation": 7.5,
  "isAnomaly": true,
  "threshold": 5.0,
  "drift": 0.5,
  "method": "cusum"
}
```

**Anwendung:** Besonders nützlich für die Erkennung von:
- Schrittweisen Drifts
- Trendänderungen
- Kleinen, aber kontinuierlichen Abweichungen

### 9. Multi-Value Splitter

Teilt Payloads mit mehreren Werten (Arrays oder Objekte) auf, um sie einzeln zu verarbeiten.

**Eigenschaften:**
- **Quellfeld**: Feld mit den Werten (Standard: "payload")
- **Ausgabemodus**: 
  - `Sequentiell`: Sendet jeden Wert einzeln nacheinander
  - `Parallel`: Sendet alle Werte als Array
- **Original-Nachricht beibehalten**: Kopiert alle ursprünglichen Felder

**Eingabe:**
```javascript
{"payload": [35.2, 36.5, 34.8]}
// oder
{"payload": {"temp1": 35.2, "temp2": 36.5}}
```

**Ausgabe (Sequentiell):**
```javascript
{"payload": 35.2, "valueIndex": 0, "valueName": "temp1", "totalValues": 2}
{"payload": 36.5, "valueIndex": 1, "valueName": "temp2", "totalValues": 2}
```

### 10. Multi-Value Anomaly

Analysiert mehrere Werte gleichzeitig auf Anomalien (jeder Wert hat einen eigenen Buffer).

**Eigenschaften:**
- **Methode**: Z-Score, IQR oder Threshold
- **Schwellenwert**: Für Z-Score Methode
- **Min/Max-Schwellenwert**: Für Threshold Methode
- **Fenstergröße**: Anzahl der Werte pro Buffer

**Eingabe:**
```javascript
{"payload": [35.2, 36.5, 45.8]}
```

**Ausgabe:**
```javascript
{
  "payload": [
    {"valueName": "value0", "value": 35.2, "isAnomaly": false, "zScore": 1.2},
    {"valueName": "value1", "value": 36.5, "isAnomaly": false, "zScore": 0.8},
    {"valueName": "value2", "value": 45.8, "isAnomaly": true, "zScore": 4.2}
  ],
  "hasAnomaly": true,
  "anomalyCount": 1
}
```

## Payload Format

**Wichtig:** Alle Nodes erwarten einen **numerischen Wert** im `msg.payload` Feld.

### Einfachste Form
```javascript
{
  "payload": 42.5
}
```

Oder als String (wird automatisch konvertiert):
```javascript
{
  "payload": "42.5"
}
```

### Kontinuierlicher Datenfluss
Die Nodes sind für **kontinuierliche Zeitreihendaten** ausgelegt:
- Jede Nachricht enthält **einen einzelnen Wert**
- Werte kommen **nacheinander** (z.B. jede Sekunde)
- Die Nodes verwenden ein **gleitendes Fenster** für Berechnungen

### Beispiel mit Metadaten
Zusätzliche Felder werden in der Ausgabe beibehalten:
```javascript
// Eingabe
{
  "payload": 42.5,
  "sensorId": "sensor-001",
  "timestamp": 1234567890
}

// Ausgabe
{
  "payload": 42.5,
  "zScore": 1.2,
  "isAnomaly": false,
  "sensorId": "sensor-001",  // ← beibehalten
  "timestamp": 1234567890    // ← beibehalten
}
```

**Weitere Details:** 
- [PAYLOAD_FORMAT.md](PAYLOAD_FORMAT.md) - Ausführliche Beispiele und Fehlerbehandlung
- [MULTI_VALUE.md](MULTI_VALUE.md) - Umgang mit mehreren Werten in einer Payload

## Verwendung

1. Installieren Sie das Modul in Node-RED
2. Ziehen Sie einen der Anomalieerkennungs-Nodes in Ihren Flow
3. Konfigurieren Sie die Parameter entsprechend Ihren Anforderungen
4. Verbinden Sie den Node mit einer Datenquelle (z.B. MQTT, HTTP, etc.)
   - **Wichtig:** Stellen Sie sicher, dass `msg.payload` einen numerischen Wert enthält
   - Falls Ihre Daten ein Objekt sind, verwenden Sie einen Function Node, um den Wert zu extrahieren:
     ```javascript
     msg.payload = msg.payload.value; // oder msg.payload.temperature, etc.
     return msg;
     ```
5. Die Nodes haben zwei Ausgänge:
   - Ausgang 1 (oben): Normale Werte
   - Ausgang 2 (unten): Anomalien

## Beispiel-Flow

```
[inject] -> [Z-Score Anomalie] -> [switch] -> [debug normal]
                              -> [debug anomalie]
```

## Abhängigkeiten

- `ml-isolation-forest`: Für Isolation Forest Anomalieerkennung (optional)
- `simple-statistics`: Für erweiterte statistische Funktionen (optional)

## Entwicklung

### Mit Docker Compose (Empfohlen)

Das einfachste Setup für die Entwicklung:

```bash
# Repository klonen
git clone <repository-url>
cd node-red-contrib-condition-monitoring

# Mit Docker Compose starten (Entwicklungsmodus)
docker-compose -f docker-compose.dev.yml up --build

# Node-RED ist jetzt verfügbar unter:
# http://localhost:1880
```

**Vorteile:**
- Automatisches Hot-Reload: Änderungen an den Nodes werden automatisch erkannt
- Isoliertes Environment
- Keine lokale Node-RED Installation nötig
- Node-RED Daten werden in `./node-red-data` gespeichert

**Stoppen:**
```bash
docker-compose -f docker-compose.dev.yml down
```

**Logs anzeigen:**
```bash
docker-compose -f docker-compose.dev.yml logs -f
```

### Lokale Entwicklung

```bash
# Repository klonen
git clone <repository-url>
cd node-red-contrib-condition-monitoring

# Abhängigkeiten installieren
npm install

# In Node-RED entwickeln
# Option 1: npm link verwenden
npm link
cd ~/.node-red
npm link node-red-contrib-condition-monitoring

# Option 2: Manuell kopieren
# Kopieren Sie den Ordner nach ~/.node-red/node_modules/node-red-contrib-condition-monitoring
```

### Docker Compose Optionen

**Produktionsmodus:**
```bash
docker-compose up --build
```

**Entwicklungsmodus (mit Hot-Reload):**
```bash
docker-compose -f docker-compose.dev.yml up --build
```

Im Entwicklungsmodus wird das gesamte Projekt als Volume gemountet, sodass Änderungen sofort sichtbar sind.

**Weitere Informationen:** Siehe [DOCKER.md](DOCKER.md) für detaillierte Docker-Dokumentation.

## Lizenz

MIT License - siehe LICENSE Datei für Details.

## Autor

blanpa

## Beitragen

Beiträge sind willkommen! Bitte erstellen Sie einen Pull Request oder öffnen Sie ein Issue für Vorschläge oder Fehler.
