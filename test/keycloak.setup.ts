// Explicit synthetic trust; no real credentials or network endpoints.
Object.assign(process.env, {
  USE_KEYCLOAK: 'true',
  KEYCLOAK_ISSUER: 'https://keycloak.forms.test/realms/test',
  KEYCLOAK_AUDIENCE: 'forms-api',
  KEYCLOAK_TOKEN_URL: 'https://keycloak.forms.test/m2m/token',
  ALLOW_LEGACY_USER_AUDIENCE: 'true',
});
