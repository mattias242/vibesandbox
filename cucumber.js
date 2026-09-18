// Node kör TypeScript direkt (typstrippning), så stegdefinitionerna behöver ingen transpilering.
const gemensamt = {
  paths: ['features/**/*.feature'],
  import: ['features/steg/**/*.ts'],
  language: 'sv',
  format: ['progress-bar', 'summary'],
};

// @senare: beslutat beteende som ännu inte är byggt.
// @pågår: egenskapen byggs just nu; taggen tas bort när stegen finns, så att `main` alltid är grön.
export default { ...gemensamt, tags: 'not @senare and not @pågår' };

// `npx cucumber-js -p pagar` kör det som är under arbete.
export const pagar = { ...gemensamt, tags: '@pågår and not @senare' };
