module.exports = function(RED) {
    "use strict";
    
    function MultiValueSplitterNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        this.field = config.field || "payload";
        this.outputMode = config.outputMode || "sequential"; // "sequential" oder "parallel"
        this.preserveOriginal = config.preserveOriginal !== undefined ? config.preserveOriginal : true;
        
        node.on('input', function(msg) {
            try {
                // Extract field (defaults to payload)
                var sourceField = node.field === "payload" ? msg.payload : RED.util.getMessageProperty(msg, node.field);
                
                if (sourceField === undefined || sourceField === null) {
                    node.error("Feld '" + node.field + "' nicht gefunden oder leer", msg);
                    return;
                }
                
                var values = [];
                var valueNames = [];
                
                // Check if it's an array
                if (Array.isArray(sourceField)) {
                    values = sourceField;
                    valueNames = values.map(function(v, i) { return "value" + i; });
                }
                // Check if it's an object with numeric values
                else if (typeof sourceField === 'object' && sourceField !== null) {
                    var keys = Object.keys(sourceField);
                    values = keys.map(function(key) {
                        var val = sourceField[key];
                        if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                            valueNames.push(key);
                            return parseFloat(val);
                        }
                        return null;
                    }).filter(function(v) { return v !== null; });
                }
                // Einzelner Wert
                else {
                    var val = parseFloat(sourceField);
                    if (!isNaN(val)) {
                        values = [val];
                        valueNames = ["value"];
                    } else {
                        node.error("No valid numeric values found", msg);
                        return;
                    }
                }
                
                if (values.length === 0) {
                    node.error("Keine Werte zum Verarbeiten gefunden", msg);
                    return;
                }
                
                // Sequentieller Modus: Werte nacheinander senden
                if (node.outputMode === "sequential") {
                    values.forEach(function(value, index) {
                        var newMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                        newMsg.payload = value;
                        newMsg.valueIndex = index;
                        newMsg.valueName = valueNames[index] || ("value" + index);
                        newMsg.totalValues = values.length;
                        node.send(newMsg);
                    });
                }
                // Paralleler Modus: Alle Werte in einem Array senden
                else {
                    var outputMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                    outputMsg.payload = values;
                    outputMsg.valueNames = valueNames;
                    outputMsg.valueCount = values.length;
                    node.send(outputMsg);
                }
                
            } catch (err) {
                node.error("Fehler beim Verarbeiten mehrerer Werte: " + err.message, msg);
            }
        });
    }
    
    RED.nodes.registerType("multi-value-splitter", MultiValueSplitterNode);
};

