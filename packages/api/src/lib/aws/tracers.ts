const TRACERS: [RegExp, string][] = [
  [/lumigo/i, 'Lumigo'],
  [/datadog/i, 'Datadog'],
  [/new-?relic/i, 'New Relic'],
  [/dynatrace/i, 'Dynatrace'],
  [/elastic/i, 'Elastic APM'],
  [/sentry/i, 'Sentry'],
  [/instana/i, 'Instana'],
  [/appdynamics/i, 'AppDynamics'],
  [/otel|opentelemetry/i, 'OpenTelemetry'],
];

/** The tracer behind an exec wrapper path (`/opt/lumigo_wrapper` → Lumigo), or null when it isn't recognisable. */
export function tracerName(wrapper: string): string | null {
  return TRACERS.find(([re]) => re.test(wrapper))?.[1] ?? null;
}
