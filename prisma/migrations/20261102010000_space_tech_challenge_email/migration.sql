-- Internal notification for SpaceTech landing page challenges (form space_tech_challenge).
-- Every submission goes to a fixed recipient list, with the submitter as reply-to.
-- forms-processor-v6 supplies the settings from SPACE_TECH_CHALLENGE_RECIPIENTS and
-- SPACE_TECH_CHALLENGE_TEMPLATE_ID (SSM); they replace these database settings.
-- Seeded disabled: enable it after both parameters are set and the processor is redeployed.
INSERT INTO forms."ProcessorFlow" (id, "formKey", action, rules)
VALUES ('space-tech-challenge-email', 'space_tech_challenge', 'sendgrid-email', '{"all":[]}')
ON CONFLICT (id) DO NOTHING;
