const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { NodeSDK } = require("@opentelemetry/sdk-node");

const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"}/v1/traces`;
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: endpoint }),
  instrumentations: [getNodeAutoInstrumentations()]
});

sdk.start();
