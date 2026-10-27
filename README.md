This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Browser connection

Set `FRONTEND_ORIGIN=http://localhost:3000` in `.env.local` for local development.
In Vercel Production, use `https://trial-magica-frontend.vercel.app` and redeploy.
Origins must have no trailing slash. CORS is not authentication.
`GET /api/health` supports configured-origin browser requests and originless health probes.
`OPTIONS /api/health` permits GET with Authorization and Content-Type headers.

The health contract is owned by `src/contracts/health.ts`. Export changes with:
`node scripts/export-contracts.mjs "../Magica Frontend/src/generated"`.
Commit the generated frontend file with its consuming change. Deployments do not need sibling checkouts.
Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before publishing.

## Session authentication

`GET /api/app/v1/me` accepts a Clerk session token in `Authorization: Bearer ...`.
It returns `{ "userId": "user_..." }` from verified session claims only. No user records or passwords are stored here yet.
Missing or rejected sessions return 401; unavailable verification returns 503. Responses are not cached.
OPTIONS preflight is unauthenticated, and auth error responses retain CORS headers.

Use the same Clerk application and instance as the frontend. In your host terminal:

```bash
npx -y clerk@latest link --app app_3LHpn5TyCbBEbkM3vrRXHeLfgSf
npx -y clerk@latest env pull
```

The server requires `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` (or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), and `FRONTEND_ORIGIN`.
Do not commit actual keys. No Clerk init or UI provider is needed in this API-only project.
For deployed testing, configure matching instance keys in each Vercel project and redeploy; Vercel's Production environment does not itself select a Clerk instance.
Validate locally at the signed-in frontend's `/connection` page, then sign out and confirm no identity remains.
