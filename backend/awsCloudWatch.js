const { GetMetricStatisticsCommand } = require("@aws-sdk/client-cloudwatch");

const PERIOD_SECONDS = 300;
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

const EC2_METRICS = [
  { name: "CPUUtilization", statistic: "Average", unit: "Percent" },
  { name: "NetworkIn", statistic: "Sum", unit: "Bytes" },
  { name: "NetworkOut", statistic: "Sum", unit: "Bytes" },
  { name: "StatusCheckFailed", statistic: "Maximum", unit: "Count" },
];

async function fetchEc2Metrics({ client, instanceId, now = Date.now() }) {
  const endMs = Math.floor(now / (PERIOD_SECONDS * 1000)) * PERIOD_SECONDS * 1000;
  const startMs = endMs - LOOKBACK_MS;
  const endTime = new Date(endMs);
  const startTime = new Date(startMs);

  const batches = await Promise.all(EC2_METRICS.map(async (metric) => {
    const response = await client.send(new GetMetricStatisticsCommand({
      Namespace: "AWS/EC2",
      MetricName: metric.name,
      Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      StartTime: startTime,
      EndTime: endTime,
      Period: PERIOD_SECONDS,
      Statistics: [metric.statistic],
    }));

    return (response.Datapoints || [])
      .filter((point) => point.Timestamp != null && Number.isFinite(point[metric.statistic]))
      .map((point) => ({
        metric_name: metric.name,
        timestamp: new Date(point.Timestamp).getTime(),
        value: point[metric.statistic],
        unit: metric.unit,
        statistic: metric.statistic,
        period_seconds: PERIOD_SECONDS,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }));

  return {
    start_time: startMs,
    end_time: endMs,
    points: batches.flat(),
  };
}

module.exports = { fetchEc2Metrics, EC2_METRICS, PERIOD_SECONDS, LOOKBACK_MS };
