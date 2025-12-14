# Mehrere Werte in einer Payload

Wenn Ihre Payload mehrere Werte enthält (z.B. mehrere Sensoren oder ein Array), gibt es mehrere Möglichkeiten, diese zu verarbeiten:

## Option 1: Multi-Value Splitter Node

Verwenden Sie den **Multi-Value Splitter** Node, um mehrere Werte aufzuteilen und dann einzeln zu analysieren.

### Beispiel-Flow

```
[MQTT In] -> [Multi-Value Splitter] -> [Z-Score Anomalie] -> [Debug]
```

### Eingabe-Formate

**Array:**
```javascript
{
  "payload": [35.2, 36.5, 34.8]
}
```

**Objekt:**
```javascript
{
  "payload": {
    "temperature": 35.2,
    "humidity": 65.5,
    "pressure": 1013.8
  }
}
```

### Ausgabe (Sequentieller Modus)

Jeder Wert wird einzeln gesendet:
```javascript
// Nachricht 1
{
  "payload": 35.2,
  "valueIndex": 0,
  "valueName": "temperature",
  "totalValues": 3
}

// Nachricht 2
{
  "payload": 36.5,
  "valueIndex": 1,
  "valueName": "humidity",
  "totalValues": 3
}
```

## Option 2: Multi-Value Anomaly Node

Verwenden Sie den **Multi-Value Anomaly** Node, um alle Werte gleichzeitig zu analysieren.

### Beispiel-Flow

```
[MQTT In] -> [Multi-Value Anomaly] -> [Switch] -> [Debug Normal]
                                    -> [Debug Anomalie]
```

### Eingabe

```javascript
{
  "payload": [35.2, 36.5, 34.8],
  "valueNames": ["temp1", "temp2", "temp3"]  // optional
}
```

Oder als Objekt:
```javascript
{
  "payload": {
    "temp1": 35.2,
    "temp2": 36.5,
    "temp3": 34.8
  }
}
```

### Ausgabe

```javascript
{
  "payload": [
    {
      "valueName": "temp1",
      "value": 35.2,
      "isAnomaly": false,
      "zScore": 1.2,
      "mean": 35.0,
      "stdDev": 2.3
    },
    {
      "valueName": "temp2",
      "value": 36.5,
      "isAnomaly": false,
      "zScore": 0.8,
      "mean": 35.0,
      "stdDev": 2.3
    },
    {
      "valueName": "temp3",
      "value": 45.8,
      "isAnomaly": true,
      "zScore": 4.2,
      "mean": 35.0,
      "stdDev": 2.3
    }
  ],
  "hasAnomaly": true,
  "anomalyCount": 1,
  "method": "multi-zscore"
}
```

## Option 3: Function Node zum Aufteilen

Sie können auch einen Function Node verwenden, um Werte manuell aufzuteilen:

### Beispiel: Array aufteilen

```javascript
// Function Node vor dem Anomalieerkennungs-Node
if (Array.isArray(msg.payload)) {
    var messages = [];
    msg.payload.forEach(function(value, index) {
        var newMsg = {
            payload: value,
            valueIndex: index,
            originalData: msg.payload
        };
        messages.push(newMsg);
    });
    return messages; // Sendet mehrere Nachrichten
}
return msg;
```

### Beispiel: Objekt aufteilen

```javascript
// Function Node
if (typeof msg.payload === 'object' && !Array.isArray(msg.payload)) {
    var messages = [];
    Object.keys(msg.payload).forEach(function(key) {
        var value = msg.payload[key];
        if (typeof value === 'number' || !isNaN(parseFloat(value))) {
            messages.push({
                payload: parseFloat(value),
                sensorName: key,
                originalData: msg.payload
            });
        }
    });
    return messages;
}
return msg;
```

## Vergleich der Optionen

| Option | Vorteile | Nachteile |
|--------|----------|-----------|
| **Multi-Value Splitter** | Einfach zu verwenden, flexibel | Mehrere Nachrichten |
| **Multi-Value Anomaly** | Alle Werte zusammen analysieren | Weniger flexibel |
| **Function Node** | Maximale Kontrolle | Mehr Code, Wartung |

## Praktisches Beispiel: MQTT mit mehreren Sensoren

### Szenario
MQTT-Nachricht mit mehreren Sensorwerten:

```json
{
  "topic": "sensors/all",
  "payload": "{\"temp1\": 35.2, \"temp2\": 36.5, \"pressure\": 1013.8}"
}
```

### Lösung 1: Mit Multi-Value Splitter

```
[MQTT In] -> [JSON] -> [Multi-Value Splitter] -> [Z-Score Anomalie] -> [Debug]
```

**Multi-Value Splitter Konfiguration:**
- Quellfeld: `payload`
- Ausgabemodus: `Sequentiell`

### Lösung 2: Mit Multi-Value Anomaly

```
[MQTT In] -> [JSON] -> [Multi-Value Anomaly] -> [Switch] -> [Debug]
```

**Multi-Value Anomaly Konfiguration:**
- Methode: `Z-Score`
- Schwellenwert: `3.0`

### Lösung 3: Mit Function Node

```
[MQTT In] -> [JSON] -> [Function] -> [Z-Score Anomalie] -> [Debug]
```

**Function Node Code:**
```javascript
var data = msg.payload;
var messages = [];

Object.keys(data).forEach(function(key) {
    var value = data[key];
    if (typeof value === 'number') {
        messages.push({
            payload: value,
            sensorName: key,
            timestamp: Date.now()
        });
    }
});

return messages;
```

## Empfehlung

- **Für einfache Fälle:** Multi-Value Splitter + einzelne Anomalieerkennungs-Nodes
- **Für komplexe Analysen:** Multi-Value Anomaly Node
- **Für spezielle Anforderungen:** Function Node

