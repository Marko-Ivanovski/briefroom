import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/routeTree.gen.ts',
      '.claude/worktrees/**',
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@thallesp/nestjs-better-auth',
              importNames: [
                'Roles',
                'UserHasPermission',
                'OrgRoles',
                'MemberHasPermission',
                'RequireActiveOrg',
              ],
              message:
                'These decorators read the admin-plugin user.role or the active organization, not our workspace role. Use the workspace role guard from apps/api/src/access instead.',
            },
          ],
        },
      ],
    },
  },
);
