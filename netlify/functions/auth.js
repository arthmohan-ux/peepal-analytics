exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { username, password } = body;

  if (
    username !== process.env.SITE_USERNAME ||
    password !== process.env.SITE_PASSWORD
  ) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid credentials' }),
    };
  }

  // Simple token: base64 of username:password — validated on each request
  const token = Buffer.from(`${username}:${password}`).toString('base64');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  };
};
