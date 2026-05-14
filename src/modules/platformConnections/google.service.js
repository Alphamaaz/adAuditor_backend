import axios from "axios";

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET;
const CALLBACK_URL = () => process.env.GOOGLE_CALLBACK_URL;

/**
 * Exchange the auth code for an access token and refresh token using Google's OAuth2 endpoint.
 */
export const exchangeCodeForToken = async (code) => {
  const { data } = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    grant_type: "authorization_code",
    redirect_uri: CALLBACK_URL(),
  });

  if (data.error) {
    throw new Error(`Google Auth Error: ${data.error_description} (${data.error})`);
  }

  return data; // { access_token, refresh_token, expires_in, scope, token_type, id_token }
};
