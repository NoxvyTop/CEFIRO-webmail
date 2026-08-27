-- #290: an optional, per-deployment display name for the SSO provider, shown on
-- the login button ("Iniciar sesión con {provider}" / "Sign in with {provider}").
-- Nullable with no default: unset (or blank) is treated as "SSO" by the app.
alter table sso_config add column provider_name text;
