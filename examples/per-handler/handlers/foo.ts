export async function handlerA() {
  return {
    statusCode: 200,
    body: JSON.stringify({ handler: 'handlerA' }),
  };
}

export async function handlerB() {
  return {
    statusCode: 200,
    body: JSON.stringify({ handler: 'handlerB' }),
  };
}
