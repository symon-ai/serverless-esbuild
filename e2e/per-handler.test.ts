import fs from 'fs';
import path from 'path';

test('per-handler', () => {
  const testArtifactPath = path.resolve(__dirname, '../.test-artifacts/per-handler/.serverless');

  const cloudformation = require(path.join(testArtifactPath, 'cloudformation-template-update-stack.json'));

  const fooContents = fs.readFileSync(path.join(testArtifactPath, 'handlers/foo.js')).toString();
  const barContents = fs.readFileSync(path.join(testArtifactPath, 'handlers/bar.js')).toString();

  expect(fooContents).toMatchSnapshot();
  expect(barContents).toMatchSnapshot();

  expect(cloudformation.AWSTemplateFormatVersion).toMatchSnapshot();
  expect(cloudformation.Description).toMatchSnapshot();

  expect(cloudformation.Outputs).toMatchSnapshot({
    FuncALambdaFunctionQualifiedArn: {
      Value: { Ref: expect.any(String) },
    },
    FuncBLambdaFunctionQualifiedArn: {
      Value: { Ref: expect.any(String) },
    },
    FuncCLambdaFunctionQualifiedArn: {
      Value: { Ref: expect.any(String) },
    },
  });

  const funcALambdaVersionPropertyKey = cloudformation.Outputs.FuncALambdaFunctionQualifiedArn.Value
    .Ref as keyof typeof cloudformation.Resources;
  const funcBLambdaVersionPropertyKey = cloudformation.Outputs.FuncBLambdaFunctionQualifiedArn.Value
    .Ref as keyof typeof cloudformation.Resources;
  const funcCLambdaVersionPropertyKey = cloudformation.Outputs.FuncCLambdaFunctionQualifiedArn.Value
    .Ref as keyof typeof cloudformation.Resources;

  const apiGatewayDeploymentPropertyKey = Object.keys(cloudformation.Resources).find((s) =>
    s.startsWith('ApiGatewayDeployment')
  ) as keyof typeof cloudformation.Resources;

  const {
    [apiGatewayDeploymentPropertyKey]: apiGatewayDeployment,
    [funcALambdaVersionPropertyKey]: funcALambdaVersion,
    [funcBLambdaVersionPropertyKey]: funcBLambdaVersion,
    [funcCLambdaVersionPropertyKey]: funcCLambdaVersion,
    ...deterministicResources
  } = cloudformation.Resources;

  const funcAS3Key = deterministicResources.FuncALambdaFunction.Properties.Code.S3Key;
  const funcBS3Key = deterministicResources.FuncBLambdaFunction.Properties.Code.S3Key;
  const funcCS3Key = deterministicResources.FuncCLambdaFunction.Properties.Code.S3Key;

  expect(funcAS3Key).toEqual(funcBS3Key);
  expect(funcAS3Key).toContain('funcA.zip');
  expect(funcCS3Key).toContain('funcC.zip');
  expect(funcCS3Key).not.toEqual(funcAS3Key);

  expect(deterministicResources).toMatchSnapshot({
    FuncALambdaFunction: {
      Properties: {
        Code: { S3Key: expect.stringContaining('funcA.zip') },
      },
    },
    FuncBLambdaFunction: {
      Properties: {
        Code: { S3Key: expect.stringContaining('funcA.zip') },
      },
    },
    FuncCLambdaFunction: {
      Properties: {
        Code: { S3Key: expect.stringContaining('funcC.zip') },
      },
    },
  });

  expect(apiGatewayDeployment).toMatchSnapshot();
  expect(funcALambdaVersion).toMatchSnapshot({
    Properties: { CodeSha256: expect.any(String) },
  });
  expect(funcBLambdaVersion).toMatchSnapshot({
    Properties: { CodeSha256: expect.any(String) },
  });
  expect(funcCLambdaVersion).toMatchSnapshot({
    Properties: { CodeSha256: expect.any(String) },
  });
});
