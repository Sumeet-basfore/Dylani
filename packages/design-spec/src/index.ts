import {z} from 'zod';

export const DESIGN_SPEC_VERSION='1.0' as const;
export const DESIGN_SKILL_IDS=['typography','layout','responsive','accessibility','composition'] as const;

const colorSchema=z.string().regex(/^#[0-9a-f]{6}$/i);
const lengthSchema=z.string().regex(/^\d{1,3}(?:\.\d+)?(?:px|rem)$/);

export const designTokensSchema=z.object({
  color:z.object({
    brand:colorSchema,background:colorSchema,surface:colorSchema,foreground:colorSchema,muted:colorSchema
  }).strict(),
  radius:z.object({card:lengthSchema,button:lengthSchema}).strict(),
  spacing:z.object({section:lengthSchema}).strict()
}).strict();

const designElementSchema=z.discriminatedUnion('type',[
  z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),type:z.literal('text'),text:z.string().min(1).max(500)}).strict(),
  z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),type:z.literal('button'),label:z.string().min(1).max(100)}).strict(),
  z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),type:z.literal('metric'),label:z.string().min(1).max(100),value:z.string().min(1).max(100)}).strict(),
  z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),type:z.literal('input'),label:z.string().min(1).max(100),placeholder:z.string().max(120).optional()}).strict(),
  z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),type:z.literal('list'),label:z.string().min(1).max(100),items:z.array(z.string().min(1).max(160)).min(1).max(8)}).strict(),
  z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),type:z.literal('badge'),text:z.string().min(1).max(60)}).strict()
]);

const designComponentSchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  type:z.enum(['hero','section','card-grid','sidebar']),
  title:z.string().min(1).max(120),
  description:z.string().max(320).optional(),
  children:z.array(designElementSchema).max(12)
}).strict();

export const designSpecSchema=z.object({
  schemaVersion:z.literal(DESIGN_SPEC_VERSION),
  platform:z.enum(['web','mobile']),
  pageType:z.enum(['landing','dashboard','settings','form','catalog','detail','onboarding','other']),
  requirements:z.array(z.string().min(1).max(280)).min(1).max(12),
  layout:z.object({
    kind:z.enum(['single-column','sidebar','two-column','grid']),
    density:z.enum(['compact','comfortable','spacious'])
  }).strict(),
  tokens:designTokensSchema,
  components:z.array(designComponentSchema).min(1).max(8),
  responsive:z.object({
    mobile:z.enum(['stack','horizontal-scroll']),
    desktop:z.enum(['centered','sidebar','two-column','three-column'])
  }).strict(),
  selectedSkills:z.array(z.enum(DESIGN_SKILL_IDS)).max(DESIGN_SKILL_IDS.length)
}).strict().superRefine((spec,context)=>{
  const ids=[...spec.components.flatMap(component=>[component.id,...component.children.map(child=>child.id)])];
  if (new Set(ids).size!==ids.length) context.addIssue({code:'custom',path:['components'],message:'Component IDs must be unique'});
  if (new Set(spec.selectedSkills).size!==spec.selectedSkills.length) context.addIssue({code:'custom',path:['selectedSkills'],message:'Selected skills must be unique'});
});

export type DesignSpec=z.infer<typeof designSpecSchema>;
export type DesignComponent=z.infer<typeof designComponentSchema>;
export type DesignElement=z.infer<typeof designElementSchema>;

export function buildDesignSpecPrompt(input:{prompt:string;platform:'web';tokens:DesignSpec['tokens'];selectedSkills:readonly string[]}) {
  return [
    'Create a framework-neutral design specification, not source code. Return one JSON object only; do not use markdown fences.',
    `The object must match schema version ${DESIGN_SPEC_VERSION} exactly and include: schemaVersion, platform, pageType, requirements, layout, tokens, components, responsive, selectedSkills.`,
    'Allowed pageType values: landing, dashboard, settings, form, catalog, detail, onboarding, other.',
    'Layout kind values: single-column, sidebar, two-column, grid. Density values: compact, comfortable, spacious.',
    'Components are an array of sections with id, type, title, optional description, and children. Parent types: hero, section, card-grid, sidebar. Child types: text (text), button (label), metric (label and value), input (label and optional placeholder), list (label and 1-8 items), badge (text). Use unique lowercase kebab-case ids. Do not include markup, CSS, code, URLs, package names, or commands.',
    'Responsive mobile values: stack or horizontal-scroll. Desktop values: centered, sidebar, two-column, three-column.',
    `User requirements: ${JSON.stringify(input.prompt)}`,
    `Target platform: ${input.platform}. Use these exact design tokens: ${JSON.stringify(input.tokens)}`,
    `Selected design skills: ${JSON.stringify(input.selectedSkills)}. Copy tokens and selectedSkills exactly. Keep all component text aligned with the user requirements.`
  ].join('\n');
}
