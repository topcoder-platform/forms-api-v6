// Explicit synthetic trust; no real credentials or network endpoints.
Object.assign(process.env, {
  M2M_PROVIDER: 'keycloak',
  KEYCLOAK_ISSUER: 'https://keycloak.forms.test/realms/test',
  KEYCLOAK_AUDIENCE: 'forms-api',
  KEYCLOAK_TOKEN_URL: 'https://keycloak.forms.test/m2m/token',
  ALLOW_LEGACY_USER_AUDIENCE: 'true',
});
