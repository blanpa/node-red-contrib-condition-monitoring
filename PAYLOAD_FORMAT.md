# Payload Format und Datenfluss

## Grundlegendes Format

Alle Anomalieerkennungs-Nodes erwarten **numerische Werte** im `msg.payload` Feld.

### Einfachste Form

```javascript
{
  "payload": 42.5
}
```

Die Nodes extrahieren den Wert mit `parseFloat(msg.payload)`, daher funktionieren auch:

### Als String

```javascript
{
  "payload": "42.5"
}
```

### Als Zahl

```javascript
{
  "payload": 42.5
}
```

## Kontinuierlicher Datenfluss

Die Nodes sind für **kontinuierliche Zeitreihendaten** ausgelegt. Das bedeutet:

1. **Werte kommen nacheinander** - Jede Nachricht enthält einen einzelnen Wert
2. **Zeitreihenfolge** - Die Reihenfolge der Nachrichten ist wichtig
3. **Gleitendes Fenster** - Die meisten Nodes verwenden ein gleitendes Fenster (z.B. 100 Werte)

### Beispiel: Sensor-Daten

```javascript
// Nachricht 1
{
  "payload": 35.2,
  "timestamp": 1234567890,
  "sensor": "temperature"
}

// Nachricht 2 (1 Sekunde später)
{
  "payload": 35.5,
  "timestamp": 1234567891,
  "sensor": "temperature"
}

// Nachricht 3
{
  "payload": 35.8,
  "timestamp": 1234567892,
  "sensor": "temperature"
}
```

**Wichtig:** Die Nodes extrahieren nur `msg.payload` für die Berechnung. Alle anderen Felder werden in der Ausgabe-Nachricht beibehalten.

## Typische Node-RED Flows

### Beispiel 1: MQTT Sensor → Anomalieerkennung

```
[MQTT In] -> [Function: Extract Value] -> [Z-Score Anomalie] -> [Switch] -> [Debug Normal]
                                                              -> [Debug Anomalie]
```

**Function Node (Extract Value):**
```javascript
// Falls die MQTT-Nachricht ein JSON-Objekt ist
var data = JSON.parse(msg.payload);
msg.payload = data.temperature; // oder data.value, etc.
return msg;
```

**Oder direkt:**
```javascript
// Falls msg.payload bereits der Wert ist
// Keine Function Node nötig!
```

### Beispiel 2: HTTP Request → Anomalieerkennung

```
[HTTP Request] -> [JSON] -> [Function] -> [IQR Anomalie] -> [HTTP Response]
```

**Function Node:**
```javascript
// Extrahiere den Wert aus dem JSON
msg.payload = msg.payload.value; // oder msg.payload.data, etc.
return msg;
```

### Beispiel 3: Inject Node für Tests

```
[Inject] -> [Z-Score Anomalie] -> [Debug]
```

**Inject Node Konfiguration:**
- **Payload:** `35.5` (als Zahl oder String)
- **Repeat:** `interval` (z.B. jede Sekunde)

## Erweiterte Nutzung

### Mit zusätzlichen Metadaten

Die Nodes kopieren alle Felder außer `payload` in die Ausgabe:

```javascript
// Eingabe
{
  "payload": 42.5,
  "sensorId": "sensor-001",
  "location": "room-1",
  "unit": "celsius"
}

// Ausgabe (normale Werte)
{
  "payload": 42.5,
  "zScore": 1.2,
  "mean": 35.0,
  "stdDev": 6.25,
  "isAnomaly": false,
  "threshold": 3.0,
  "sensorId": "sensor-001",  // ← beibehalten
  "location": "room-1",      // ← beibehalten
  "unit": "celsius"          // ← beibehalten
}
```

### Mit Timestamps

```javascript
{
  "payload": 42.5,
  "timestamp": 1234567890,
  "_msgid": "abc123"
}
```

## Fehlerbehandlung

### Ungültige Werte

Wenn `msg.payload` keine gültige Zahl ist, geben die Nodes einen Fehler aus:

```javascript
// ❌ Falsch - wird einen Fehler auslösen
{
  "payload": "nicht eine zahl"
}

// ❌ Falsch - wird einen Fehler auslösen
{
  "payload": null
}

// ❌ Falsch - wird einen Fehler auslösen
{
  "payload": {}
}

// ✅ Richtig
{
  "payload": 42.5
}

// ✅ Richtig (wird automatisch konvertiert)
{
  "payload": "42.5"
}
```

## Praktische Beispiele

### Beispiel: Temperatursensor

```javascript
// MQTT Nachricht empfangen
{
  "topic": "sensors/temperature/room1",
  "payload": "{\"value\": 22.5, \"timestamp\": 1234567890}"
}

// Function Node: JSON parsen und Wert extrahieren
var data = JSON.parse(msg.payload);
msg.payload = data.value; // 22.5
msg.timestamp = data.timestamp;
return msg;

// Anomalieerkennungs-Node verarbeitet:
// msg.payload = 22.5
```

### Beispiel: Mehrere Sensoren

Für mehrere Sensoren sollten Sie separate Nodes verwenden:

```
[MQTT In] -> [Function: Route by Sensor] -> [Z-Score Node 1] (Sensor A)
                                         -> [Z-Score Node 2] (Sensor B)
                                         -> [Z-Score Node 3] (Sensor C)
```

**Function Node (Route by Sensor):**
```javascript
var sensorId = msg.sensorId;
// Verwenden Sie einen Switch Node oder senden Sie an verschiedene Nodes
return msg;
```

## Mehrere Werte in einer Payload

Wenn Ihre Payload mehrere Werte enthält, gibt es spezielle Nodes dafür:

### Option 1: Multi-Value Splitter
Teilt Arrays oder Objekte auf, um jeden Wert einzeln zu analysieren:

```javascript
// Eingabe
{"payload": [35.2, 36.5, 34.8]}

// Ausgabe (jeder Wert einzeln)
{"payload": 35.2, "valueIndex": 0, "valueName": "value0"}
{"payload": 36.5, "valueIndex": 1, "valueName": "value1"}
```

### Option 2: Multi-Value Anomaly
Analysiert alle Werte gleichzeitig:

```javascript
// Eingabe
{"payload": [35.2, 36.5, 34.8]}

// Ausgabe
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

**Weitere Details:** Siehe [MULTI_VALUE.md](MULTI_VALUE.md) für ausführliche Beispiele.

## Zusammenfassung

✅ **Erlaubt (für einzelne Werte):**
- `msg.payload` als Zahl: `42.5`
- `msg.payload` als String: `"42.5"`
- Zusätzliche Felder werden beibehalten

✅ **Erlaubt (für mehrere Werte):**
- `msg.payload` als Array: `[42.5, 43.0]` → Verwenden Sie Multi-Value Splitter oder Multi-Value Anomaly
- `msg.payload` als Objekt: `{"temp1": 42.5, "temp2": 43.0}` → Verwenden Sie Multi-Value Nodes

❌ **Nicht erlaubt (ohne Vorverarbeitung):**
- `msg.payload` als Objekt mit einem Wert: `{"value": 42.5}` (muss extrahiert werden)
- `msg.payload` als null/undefined

💡 **Tipp:** 
- Für einzelne Werte: Verwenden Sie einen Function Node, um komplexe Datenstrukturen zu extrahieren
- Für mehrere Werte: Verwenden Sie Multi-Value Splitter oder Multi-Value Anomaly Nodes

```javascript
// Function Node für einzelne Werte
msg.payload = msg.payload.value; // oder msg.payload.data, etc.
return msg;
```

