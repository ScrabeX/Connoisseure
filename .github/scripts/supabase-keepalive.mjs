const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const groupPassword = process.env.SUPABASE_GROUP_PASSWORD;
const groupEmail = 'connoisseur.pro@gmx.de';

for (const [name, value] of Object.entries({
  SUPABASE_URL: supabaseUrl,
  SUPABASE_PUBLISHABLE_KEY: publishableKey,
  SUPABASE_GROUP_PASSWORD: groupPassword
})) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

const baseUrl = supabaseUrl.replace(/\/+$/, '');

async function requireSuccess(response, operation) {
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }
  return response;
}

const authResponse = await requireSuccess(
  await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({email: groupEmail, password: groupPassword})
  }),
  'Supabase sign-in'
);
const {access_token: accessToken} = await authResponse.json();
if (!accessToken) throw new Error('Supabase sign-in returned no access token');

const membersResponse = await requireSuccess(
  await fetch(`${baseUrl}/rest/v1/members?select=id&limit=1`, {
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`
    }
  }),
  'Supabase members query'
);
const members = await membersResponse.json();

console.log(`Supabase health check succeeded; members query returned ${members.length} row(s).`);
