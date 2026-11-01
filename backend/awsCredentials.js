const { CloudWatchClient } = require("@aws-sdk/client-cloudwatch");
const { AssumeRoleCommand, STSClient } = require("@aws-sdk/client-sts");

async function assumeRoleCredentials({ region, roleArn, externalId, projectId, client = new STSClient({ region }) }) {
  let response;
  try {
    response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `CloudRewind-${projectId || "metrics"}`,
      ExternalId: externalId,
      DurationSeconds: 900,
    }));
  } catch (cause) {
    const error = new Error("Could not assume the configured customer AWS role");
    error.name = "AssumeRoleFailure";
    error.cause = cause;
    throw error;
  }

  const credentials = response?.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    const error = new Error("AWS STS returned incomplete temporary credentials");
    error.name = "AssumeRoleFailure";
    throw error;
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}

async function createCloudWatchClient(connection, { stsClient, cloudWatchClientFactory = (options) => new CloudWatchClient(options) } = {}) {
  const options = { region: connection.region };
  if (connection.role_arn) {
    if (!connection.external_id) {
      const error = new Error("The AWS role connection has no external ID");
      error.name = "AssumeRoleFailure";
      throw error;
    }
    options.credentials = await assumeRoleCredentials({
      region: connection.region,
      roleArn: connection.role_arn,
      externalId: connection.external_id,
      projectId: connection.project_id,
      client: stsClient,
    });
  }
  return cloudWatchClientFactory(options);
}

module.exports = { assumeRoleCredentials, createCloudWatchClient };
