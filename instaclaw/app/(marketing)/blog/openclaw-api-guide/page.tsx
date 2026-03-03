import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "OpenClaw API — The Developer's Guide",
  description: "Everything developers need to know about the OpenClaw API. Authentication, endpoints, rate limits, and code examples for building on top of the OpenClaw platform.",
  path: "/blog/openclaw-api-guide",
});

export default function OpenclawApiGuidePage() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: "OpenClaw API — The Developer's Guide",
          description: "Everything developers need to know about the OpenClaw API. Authentication, endpoints, rate limits, and code examples for building on top of the OpenClaw platform.",
          datePublished: "2026-03-06",
          author: {
            "@type": "Organization",
            name: "InstaClaw",
          },
        }}
      />

      <article className="mx-auto max-w-2xl px-6 py-16 sm:py-24" style={{ color: "#333334" }}>
        <Link href="/blog" className="text-sm hover:underline" style={{ color: "#DC6743" }}>
          &larr; Back to Blog
        </Link>

        <header className="mt-8 mb-12">
          <h1 className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            OpenClaw API — The Developer&apos;s Guide
          </h1>
          <p className="text-sm" style={{ color: "#6b6b6b" }}>
            March 6, 2026 &middot; 8 min read
          </p>
        </header>

        <section className="mb-12">
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>OpenClaw API</strong> is the programmatic interface to the OpenClaw platform. Whether you&apos;re building custom integrations, automating agent workflows, or creating entirely new applications on top of OpenClaw, understanding the API is essential. This guide covers everything developers need to know about the <strong style={{ color: "#333334" }}>openclaw api</strong> — from authentication and core endpoints to rate limits, error handling, and real-world code examples.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If you&apos;re new to OpenClaw itself, start with our <Link href="/blog/what-is-openclaw" className="underline" style={{ color: "#DC6743" }}>introduction to what OpenClaw is</Link> and <Link href="/how-it-works" className="underline" style={{ color: "#DC6743" }}>how the platform works</Link>. This guide assumes you have a basic understanding of the OpenClaw architecture and are ready to start building with the API.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            What Is the OpenClaw API?
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>ai agent api</strong> provided by OpenClaw is a RESTful HTTP interface that lets you control every aspect of your agent programmatically. You can create and manage agents, configure skills, trigger workflows, query logs, and integrate with external systems — all through standard HTTP requests.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Unlike traditional chatbot APIs that only accept text and return responses, the OpenClaw API exposes the full lifecycle of an agent. You can read configuration, modify behavior, inject context, and observe execution state. This makes it possible to build sophisticated automations, custom dashboards, and multi-agent orchestration systems.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The API is designed for <strong style={{ color: "#333334" }}>openclaw developer</strong> workflows. All endpoints return JSON, support standard HTTP verbs, and follow consistent patterns for pagination, filtering, and error responses. Authentication uses API keys, and rate limits are generous for typical use cases.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Authentication and API Keys
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            All requests to the <strong style={{ color: "#333334" }}>openclaw api</strong> must include an API key. You generate keys from your dashboard, and each key is scoped to a specific agent or workspace. This means you can create read-only keys for monitoring, write keys for automation, and admin keys for full control.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            To authenticate, include your API key in the <strong style={{ color: "#333334" }}>Authorization</strong> header as a Bearer token:
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`curl https://api.openclaw.io/v1/agents \\
  -H "Authorization: Bearer YOUR_API_KEY"`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If your key is invalid or expired, the API returns a <strong style={{ color: "#333334" }}>401 Unauthorized</strong> response. If your key lacks permission for a specific action, you&apos;ll receive <strong style={{ color: "#333334" }}>403 Forbidden</strong>. Always store API keys securely — treat them like passwords and never commit them to version control.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For local development, you can use environment variables to manage keys. For production deployments, consider using secret management tools like AWS Secrets Manager, HashiCorp Vault, or Kubernetes secrets.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Core API Endpoints
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The OpenClaw API is organized into several resource groups. Here are the most important endpoints for <strong style={{ color: "#333334" }}>openclaw integration</strong> workflows:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>GET /v1/agents</strong> — List all agents in your workspace. Returns an array of agent objects with id, name, status, and configuration metadata. Supports pagination via <strong style={{ color: "#333334" }}>?page</strong> and <strong style={{ color: "#333334" }}>?limit</strong> query parameters.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>POST /v1/agents</strong> — Create a new agent. Requires a JSON body with <strong style={{ color: "#333334" }}>name</strong> and optional <strong style={{ color: "#333334" }}>skills</strong>, <strong style={{ color: "#333334" }}>memory_config</strong>, and <strong style={{ color: "#333334" }}>llm_provider</strong>. Returns the created agent object with a unique ID.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>GET /v1/agents/:id</strong> — Retrieve details for a specific agent. Includes full configuration, installed skills, memory stats, and execution history.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>PATCH /v1/agents/:id</strong> — Update an agent&apos;s configuration. You can modify skills, change the LLM provider, adjust memory settings, or update environment variables. Only the fields you include in the request body are changed.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>DELETE /v1/agents/:id</strong> — Permanently delete an agent and all associated data. This operation cannot be undone, so use with caution.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>POST /v1/agents/:id/execute</strong> — Trigger a task execution. The request body should include a <strong style={{ color: "#333334" }}>prompt</strong> field with the instruction for the agent. Returns a task ID that you can use to poll for results.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>GET /v1/tasks/:id</strong> — Check the status of a running task. Returns <strong style={{ color: "#333334" }}>pending</strong>, <strong style={{ color: "#333334" }}>running</strong>, <strong style={{ color: "#333334" }}>completed</strong>, or <strong style={{ color: "#333334" }}>failed</strong> along with any results or error messages.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For a complete list of endpoints and detailed request/response schemas, check the <Link href="/docs" className="underline" style={{ color: "#DC6743" }}>official documentation</Link>.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Working with Skills via the API
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Skills are the building blocks of OpenClaw agents. The <strong style={{ color: "#333334" }}>openclaw api</strong> provides dedicated endpoints for managing skills, which is essential for <strong style={{ color: "#333334" }}>openclaw integration</strong> scenarios where you need to dynamically enable or disable capabilities.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>GET /v1/skills</strong> — List all available skills in the OpenClaw ecosystem. Returns skill metadata including name, description, required permissions, and installation count. You can filter by category or search by keyword.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>POST /v1/agents/:id/skills</strong> — Install a skill on a specific agent. The request body should include the <strong style={{ color: "#333334" }}>skill_id</strong> and any configuration parameters required by that skill. For example, the Gmail skill needs OAuth credentials, while the web scraping skill might need a proxy configuration.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>DELETE /v1/agents/:id/skills/:skill_id</strong> — Remove a skill from an agent. This immediately revokes the agent&apos;s ability to use that skill in future executions.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If you&apos;re building a multi-tenant system, you might want to programmatically provision agents with different skill sets based on user tier or use case. The API makes this straightforward. For more on how skills work conceptually, see our <Link href="/blog/openclaw-skills-guide" className="underline" style={{ color: "#DC6743" }}>complete guide to OpenClaw skills</Link>.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            InstaClaw makes skill management even easier by handling OAuth flows, credential storage, and permission management automatically. If you&apos;re deploying OpenClaw at scale, InstaClaw takes care of the infrastructure so you can focus on building features. Plans start at $29/month and include managed skill installations with pre-configured credentials.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Rate Limits and Quotas
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Every <strong style={{ color: "#333334" }}>ai agent api</strong> has rate limits to ensure fair usage and system stability. The OpenClaw API uses a token-bucket algorithm with per-minute and per-hour limits. Default limits are 60 requests per minute and 1,000 requests per hour per API key.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            When you exceed a rate limit, the API returns <strong style={{ color: "#333334" }}>429 Too Many Requests</strong> along with a <strong style={{ color: "#333334" }}>Retry-After</strong> header indicating how many seconds to wait before retrying. Your application should respect this header and implement exponential backoff to avoid hammering the API.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Rate limit headers are included in every response:
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1709740800`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>X-RateLimit-Reset</strong> field is a Unix timestamp indicating when your rate limit window resets. Use this to schedule bulk operations or implement client-side throttling.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For high-volume use cases, you can request higher rate limits by contacting support. Enterprise plans include dedicated API capacity with custom limits and priority routing.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Error Handling and Response Codes
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>openclaw api</strong> uses standard HTTP status codes to indicate success or failure. Here&apos;s what each code means for <strong style={{ color: "#333334" }}>openclaw developer</strong> workflows:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>200 OK</strong> — Request succeeded. The response body contains the requested data.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>201 Created</strong> — Resource created successfully. The response includes the new resource&apos;s ID and full representation.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>400 Bad Request</strong> — Invalid request. The response body includes an <strong style={{ color: "#333334" }}>error</strong> object with a human-readable message and sometimes a <strong style={{ color: "#333334" }}>details</strong> field with validation errors.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>401 Unauthorized</strong> — Missing or invalid API key. Check your <strong style={{ color: "#333334" }}>Authorization</strong> header.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>403 Forbidden</strong> — Valid API key but insufficient permissions for the requested action.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>404 Not Found</strong> — The requested resource doesn&apos;t exist. Double-check the agent ID or endpoint path.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>429 Too Many Requests</strong> — Rate limit exceeded. Wait for the period specified in <strong style={{ color: "#333334" }}>Retry-After</strong> header.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>500 Internal Server Error</strong> — Something went wrong on OpenClaw&apos;s side. These are rare and usually transient — retry with exponential backoff.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            All error responses include a JSON body with this structure:
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`{
  "error": {
    "code": "invalid_request",
    "message": "Missing required field: name",
    "details": {
      "field": "name",
      "type": "required"
    }
  }
}`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Your client code should always check the status code and parse the error object when something fails. This makes debugging much easier and helps you provide better error messages to end users.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Code Examples for Common Use Cases
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Let&apos;s look at practical code examples for working with the <strong style={{ color: "#333334" }}>openclaw api</strong>. These examples use JavaScript and the native <strong style={{ color: "#333334" }}>fetch</strong> API, but the same patterns work in any language.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Creating an agent programmatically:</strong>
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`const response = await fetch('https://api.openclaw.io/v1/agents', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Research Assistant',
    skills: ['web_search', 'summarization'],
    memory_config: {
      type: 'persistent',
      max_tokens: 8000
    }
  })
});

const agent = await response.json();
console.log('Created agent:', agent.id);`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Executing a task and polling for results:</strong>
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`const taskResponse = await fetch(\`https://api.openclaw.io/v1/agents/\${agentId}/execute\`, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: 'Research the latest developments in quantum computing'
  })
});

const task = await taskResponse.json();
let status = 'pending';

while (status === 'pending' || status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const statusResponse = await fetch(\`https://api.openclaw.io/v1/tasks/\${task.id}\`, {
    headers: { 'Authorization': 'Bearer YOUR_API_KEY' }
  });
  
  const taskData = await statusResponse.json();
  status = taskData.status;
  
  if (status === 'completed') {
    console.log('Result:', taskData.result);
  } else if (status === 'failed') {
    console.error('Task failed:', taskData.error);
  }
}`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Installing a skill on an existing agent:</strong>
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`const skillResponse = await fetch(\`https://api.openclaw.io/v1/agents/\${agentId}/skills\`, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    skill_id: 'gmail',
    config: {
      oauth_token: 'user_oauth_token_here',
      scopes: ['read', 'send']
    }
  })
});

if (skillResponse.ok) {
  console.log('Skill installed successfully');
}`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            These patterns form the foundation of most <strong style={{ color: "#333334" }}>openclaw integration</strong> projects. You can combine them to build automation pipelines, custom dashboards, or multi-agent orchestration systems.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If you&apos;re building a production system and want to avoid managing infrastructure, InstaClaw handles hosting, monitoring, and scaling automatically. You get the same API access, but without worrying about uptime, security patches, or database backups. Learn more about <Link href="/how-it-works" className="underline" style={{ color: "#DC6743" }}>how InstaClaw works</Link>.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Webhooks and Real-Time Updates
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Polling for task status works but isn&apos;t efficient for long-running operations. The <strong style={{ color: "#333334" }}>openclaw api</strong> supports webhooks, which let you receive HTTP callbacks when events occur. This is especially useful for <strong style={{ color: "#333334" }}>openclaw developer</strong> workflows that involve asynchronous processing.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            To configure a webhook, send a <strong style={{ color: "#333334" }}>POST</strong> request to <strong style={{ color: "#333334" }}>/v1/webhooks</strong> with your callback URL and the events you want to subscribe to:
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`{
  "url": "https://yourdomain.com/webhook",
  "events": ["task.completed", "task.failed", "agent.updated"]
}`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            When a subscribed event occurs, OpenClaw sends a POST request to your endpoint with a JSON payload containing event details. Your server should respond with a <strong style={{ color: "#333334" }}>200 OK</strong> within 30 seconds. If the webhook fails repeatedly, OpenClaw will disable it and send you an email notification.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Always verify webhook signatures to ensure requests are actually from OpenClaw. Each webhook includes an <strong style={{ color: "#333334" }}>X-OpenClaw-Signature</strong> header that you can validate using your webhook secret.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            SDK and Client Libraries
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            While the raw HTTP API works perfectly fine, official SDKs make <strong style={{ color: "#333334" }}>openclaw integration</strong> even easier. OpenClaw provides client libraries for JavaScript/TypeScript, Python, Go, and Ruby. These libraries handle authentication, retries, pagination, and error handling automatically.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For example, the Python SDK simplifies agent creation to a single line:
          </p>
          <pre className="bg-gray-50 p-4 rounded text-xs mb-4 overflow-x-auto" style={{ color: "#333334" }}>
{`from openclaw import OpenClaw

client = OpenClaw(api_key='YOUR_API_KEY')
agent = client.agents.create(
  name='Research Assistant',
  skills=['web_search', 'summarization']
)

task = client.tasks.execute(agent.id, prompt='Find recent AI papers')
result = client.tasks.wait_for_completion(task.id)
print(result.output)`}
          </pre>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The SDKs also provide type definitions and IDE autocomplete, which makes development faster and reduces bugs. Check the <Link href="/docs" className="underline" style={{ color: "#DC6743" }}>documentation</Link> for installation instructions and full API reference.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Best Practices for Production Use
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            When building production systems on the <strong style={{ color: "#333334" }}>openclaw api</strong>, follow these best practices:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Implement exponential backoff</strong> for retries. Start with a 1-second delay and double it on each failure, up to a maximum of 60 seconds. This prevents your application from overwhelming the API during transient failures.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Cache responses when appropriate</strong>. If you&apos;re repeatedly fetching the same agent configuration or skill list, cache it locally with a reasonable TTL. This reduces API calls and improves your application&apos;s responsiveness.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Use webhooks instead of polling</strong> for long