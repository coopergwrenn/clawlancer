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
          datePublished: "2026-03-03",
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
            March 3, 2026 &middot; 12 min read
          </p>
        </header>

        <section className="mb-12">
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>OpenClaw API</strong> is the programmatic interface that lets developers build applications, integrations, and automations on top of the OpenClaw framework. Whether you&apos;re extending your AI agent with custom capabilities, building a third-party tool that interacts with OpenClaw, or creating automated workflows that leverage agent intelligence, the API provides the foundation you need.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            This guide covers everything from authentication and core endpoints to rate limits, error handling, and real-world code examples. If you&apos;re new to <Link href="/blog/what-is-openclaw" className="underline" style={{ color: "#DC6743" }}>what OpenClaw is</Link>, we recommend starting there. For developers ready to integrate, this is your comprehensive reference.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Why Use the OpenClaw API?
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>openclaw api</strong> enables use cases that go beyond the standard web interface. With API access, you can trigger agent actions from your own applications, retrieve task histories programmatically, manage skills and configurations remotely, and integrate OpenClaw into broader automation pipelines.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Common scenarios include building custom dashboards that display agent activity, creating Slack bots that invoke OpenClaw tasks, integrating with CI/CD pipelines for automated testing and deployment, and syncing agent data with internal databases or analytics platforms. The API gives you full control over how you interact with your AI agent infrastructure.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The <strong style={{ color: "#333334" }}>ai agent api</strong> follows RESTful conventions, uses JSON for request and response payloads, and supports both synchronous and asynchronous operations. Authentication is token-based, making it straightforward to integrate with modern development workflows.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Authentication and API Keys
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            All OpenClaw API requests require authentication via an API key. You generate keys from your InstaClaw dashboard under API Settings. Each key can be scoped to specific permissions — read-only access, write access, or full administrative control. This lets you follow the principle of least privilege when distributing keys to different services or team members.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            To authenticate a request, include your API key in the <strong style={{ color: "#333334" }}>Authorization</strong> header using the Bearer token format. Here&apos;s an example using curl:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>
              curl -H &quot;Authorization: Bearer YOUR_API_KEY&quot; https://api.instaclaw.io/v1/agents
            </code>
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            API keys are treated as sensitive credentials. Store them securely using environment variables or a secrets manager — never hardcode them in source control. If a key is compromised, you can revoke it immediately from the dashboard and generate a replacement without affecting other services.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For <strong style={{ color: "#333334" }}>openclaw developer</strong> workflows, consider using separate keys for development, staging, and production environments. This isolation reduces risk and makes it easier to track which services are making which requests.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Core API Endpoints
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The OpenClaw API is organized into several resource groups. The most commonly used endpoints include agents, tasks, skills, and configurations. Each resource supports standard CRUD operations where applicable.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Agents Endpoint</strong> — The <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>/v1/agents</code> endpoint lets you list all agents in your account, retrieve details about a specific agent, create new agent instances, and update agent configurations. This is useful when you need to programmatically spin up agents for different projects or manage agent settings across multiple deployments.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Tasks Endpoint</strong> — The <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>/v1/tasks</code> endpoint is where you create and monitor agent tasks. A POST request to this endpoint initiates a new task, while GET requests retrieve task status, results, and execution logs. For long-running tasks, the API supports webhooks that notify your application when a task completes.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Skills Endpoint</strong> — Managing agent capabilities is handled through <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>/v1/skills</code>. You can query available skills, install new skills on an agent, update skill configurations, and remove skills that are no longer needed. This endpoint integrates with the broader <Link href="/blog/openclaw-skills-guide" className="underline" style={{ color: "#DC6743" }}>skills ecosystem</Link> to keep your agents equipped with the right tools.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <strong style={{ color: "#333334" }}>Configurations Endpoint</strong> — The <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>/v1/configs</code> endpoint provides access to system-level and agent-level configuration settings. Use this to adjust resource limits, set default behaviors, configure integrations with external services, and manage environment-specific settings.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            InstaClaw takes care of hosting and maintaining these endpoints — you just focus on building your <strong style={{ color: "#333334" }}>openclaw integration</strong>. Plans start at $29 per month and include API access with generous rate limits.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Creating a Task via the API
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            One of the most powerful features of the <strong style={{ color: "#333334" }}>openclaw api</strong> is the ability to trigger agent tasks programmatically. This enables event-driven architectures where external systems can invoke agent capabilities in response to user actions, scheduled jobs, or data changes.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Here&apos;s a complete example in Node.js that creates a new task, polls for completion, and retrieves the result:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <code style={{ backgroundColor: "#f5f5f5", padding: "12px", borderRadius: "3px", fontFamily: "monospace", display: "block", whiteSpace: "pre-wrap" }}>
              {`const fetch = require('node-fetch');

const API_KEY = process.env.OPENCLAW_API_KEY;
const BASE_URL = 'https://api.instaclaw.io/v1';

async function createTask(agentId, prompt) {
  const response = await fetch(\`\${BASE_URL}/tasks\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${API_KEY}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      agent_id: agentId,
      prompt: prompt,
      priority: 'normal',
      callback_url: 'https://yourapp.com/webhooks/task-complete'
    })
  });
  return response.json();
}

async function getTaskStatus(taskId) {
  const response = await fetch(\`\${BASE_URL}/tasks/\${taskId}\`, {
    method: 'GET',
    headers: {
      'Authorization': \`Bearer \${API_KEY}\`
    }
  });
  return response.json();
}

async function main() {
  const task = await createTask('agent_123', 'Analyze the latest product feedback and summarize key themes');
  console.log('Task created:', task.id);
  
  // Poll every 5 seconds until complete
  while (true) {
    const status = await getTaskStatus(task.id);
    console.log('Status:', status.state);
    
    if (status.state === 'completed') {
      console.log('Result:', status.result);
      break;
    } else if (status.state === 'failed') {
      console.error('Error:', status.error);
      break;
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

main();`}
            </code>
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            This pattern works for any <strong style={{ color: "#333334" }}>ai agent api</strong> integration. The callback URL is optional but recommended for production use — instead of polling, your application receives a webhook notification when the task finishes.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Rate Limits and Quotas
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The OpenClaw API implements rate limiting to ensure fair usage and system stability. Rate limits vary by plan tier and endpoint. For most developers, the limits are generous enough that you won&apos;t hit them during normal operation.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Standard plans include 1,000 API calls per hour for read operations and 100 calls per hour for write operations. Task creation endpoints have a separate limit of 50 tasks per hour to prevent resource exhaustion. Higher-tier plans offer increased limits, and enterprise customers can request custom quotas based on their needs.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            When you exceed a rate limit, the API returns a <strong style={{ color: "#333334" }}>429 Too Many Requests</strong> status code along with headers indicating when you can retry. The <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>X-RateLimit-Remaining</code> and <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>X-RateLimit-Reset</code> headers let you implement intelligent backoff strategies in your client code.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For <strong style={{ color: "#333334" }}>openclaw developer</strong> projects that require burst capacity — such as batch processing or scheduled jobs — consider spreading requests over time or using the batch endpoints that let you submit multiple operations in a single API call.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            InstaClaw handles all infrastructure scaling automatically, so your API access remains fast and reliable even as usage grows. More details are available in the <Link href="/docs" className="underline" style={{ color: "#DC6743" }}>full documentation</Link>.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Error Handling and Status Codes
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The OpenClaw API uses standard HTTP status codes to indicate success or failure. A <strong style={{ color: "#333334" }}>200 OK</strong> response means the request succeeded, while <strong style={{ color: "#333334" }}>201 Created</strong> indicates a new resource was created. Client errors return 4xx codes, and server errors return 5xx codes.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Common error codes include <strong style={{ color: "#333334" }}>400 Bad Request</strong> for malformed payloads, <strong style={{ color: "#333334" }}>401 Unauthorized</strong> when authentication fails, <strong style={{ color: "#333334" }}>403 Forbidden</strong> when you lack permission for an action, and <strong style={{ color: "#333334" }}>404 Not Found</strong> when a resource doesn&apos;t exist.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Error responses include a JSON body with additional context:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <code style={{ backgroundColor: "#f5f5f5", padding: "12px", borderRadius: "3px", fontFamily: "monospace", display: "block", whiteSpace: "pre-wrap" }}>
              {`{
  "error": {
    "type": "invalid_request",
    "message": "Missing required field: agent_id",
    "param": "agent_id",
    "code": "missing_required_field"
  }
}`}
            </code>
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            This structured format makes it straightforward to display user-friendly error messages or log detailed debugging information. The <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>code</code> field provides a machine-readable identifier that your application can use to implement specific error handling logic.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For transient errors such as network timeouts or temporary service unavailability, implement exponential backoff with jitter. Most client libraries for Node.js, Python, and other languages include built-in retry logic that handles this automatically.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Webhooks and Event Notifications
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Webhooks provide a push-based alternative to polling. Instead of repeatedly checking task status, you configure a callback URL that OpenClaw invokes when events occur. This reduces API usage, improves responsiveness, and simplifies application architecture.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Webhook payloads include an event type, timestamp, and relevant data. For task completion events, you receive the full task object including results, execution time, and any error information. The <strong style={{ color: "#333334" }}>openclaw integration</strong> pattern typically involves setting up an endpoint in your application that receives these webhooks and triggers appropriate downstream actions.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Webhook requests include a signature in the <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>X-OpenClaw-Signature</code> header. You should verify this signature using your webhook secret to ensure the request originated from OpenClaw and hasn&apos;t been tampered with. Sample verification code is available in the documentation for all major languages.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            If your webhook endpoint returns a non-2xx status code or times out, OpenClaw will retry the delivery up to three times with exponential backoff. After the final retry attempt fails, the event is logged but not delivered again — you can query failed deliveries through the API and manually reprocess them if needed.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Python Example: Managing Agent Skills
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Here&apos;s a practical Python example that demonstrates listing available skills, checking which skills are installed on an agent, and adding a new skill. This is useful for automation workflows that need to dynamically configure agents based on task requirements:
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            <code style={{ backgroundColor: "#f5f5f5", padding: "12px", borderRadius: "3px", fontFamily: "monospace", display: "block", whiteSpace: "pre-wrap" }}>
              {`import os
import requests

API_KEY = os.environ['OPENCLAW_API_KEY']
BASE_URL = 'https://api.instaclaw.io/v1'
HEADERS = {
    'Authorization': f'Bearer {API_KEY}',
    'Content-Type': 'application/json'
}

def list_available_skills():
    response = requests.get(f'{BASE_URL}/skills', headers=HEADERS)
    response.raise_for_status()
    return response.json()['skills']

def get_agent_skills(agent_id):
    response = requests.get(f'{BASE_URL}/agents/{agent_id}/skills', headers=HEADERS)
    response.raise_for_status()
    return response.json()['skills']

def install_skill(agent_id, skill_id, config=None):
    payload = {'skill_id': skill_id}
    if config:
        payload['config'] = config
    
    response = requests.post(
        f'{BASE_URL}/agents/{agent_id}/skills',
        headers=HEADERS,
        json=payload
    )
    response.raise_for_status()
    return response.json()

# Example usage
agent_id = 'agent_123'
available_skills = list_available_skills()
print(f'Available skills: {len(available_skills)}')

current_skills = get_agent_skills(agent_id)
print(f'Agent currently has {len(current_skills)} skills installed')

# Install a new skill
result = install_skill(agent_id, 'skill_web_search', {
    'search_provider': 'google',
    'max_results': 10
})
print(f'Skill installed: {result["message"]}')`}
            </code>
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            This approach lets you build dynamic agent provisioning systems that adjust capabilities based on workload. Combined with the tasks API, you can create fully automated workflows that configure agents, execute tasks, and process results without manual intervention.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            API Versioning and Deprecation Policy
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The OpenClaw API uses URL-based versioning. The current stable version is <strong style={{ color: "#333334" }}>v1</strong>, indicated by the <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>/v1/</code> prefix in all endpoints. This approach ensures that your integrations continue working even as new features are added to the API.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            When breaking changes are necessary, they&apos;re introduced in a new API version such as v2. The old version remains supported for a minimum deprecation period — typically 12 months — giving you ample time to update your code. Deprecation notices are announced via email, in the developer changelog, and through response headers on affected endpoints.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Backward-compatible additions such as new optional parameters or additional response fields are added to the current version without incrementing the version number. This means you can take advantage of new features without modifying existing integration code.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For <strong style={{ color: "#333334" }}>openclaw developer</strong> teams managing long-lived integrations, we recommend subscribing to the API changelog and monitoring the <code style={{ backgroundColor: "#f5f5f5", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace" }}>X-API-Deprecated</code> response header, which appears when you&apos;re using a deprecated endpoint or feature.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Best Practices for Production Use
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            When building production applications on the <strong style={{ color: "#333334" }}>openclaw api</strong>, follow these best practices to ensure reliability and maintainability. First, always use environment variables for API keys and never commit them to source control. Use different keys for development and production environments.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Implement proper error handling with retries for transient failures. Use exponential backoff and respect rate limit headers. Log both successful and failed requests with enough detail to diagnose issues, but be careful not to log sensitive data such as API keys or personally identifiable information.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For high-availability systems, consider implementing circuit breakers that stop making requests temporarily if the API becomes unavailable. This prevents cascading failures and gives the service time to recover. Monitor API response times and error rates in your observability platform.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Cache responses where appropriate to reduce API calls and improve performance. The API includes standard HTTP caching headers that your client should respect. For frequently accessed data such as skill lists or agent configurations, a 5-minute cache TTL is usually reasonable.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Finally, keep your integration libraries up to date. Official OpenClaw client libraries are maintained for Node.js, Python, Ruby, and Go, with community libraries available for other languages. These libraries handle authentication, retries, and pagination automatically, reducing the amount of boilerplate code you need to maintain.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Getting Started with the API
          </h2>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The fastest way to get started is through InstaClaw, which provides hosted API access without any infrastructure setup. After creating an account, navigate to API Settings in your dashboard to generate your first key. The <Link href="/docs" className="underline" style={{ color: "#DC6743" }}>documentation</Link> includes interactive examples and a Postman collection you can import to test endpoints.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Start with read-only operations such as listing agents and querying task history. Once you&apos;re comfortable with authentication and response formats, move on to creating tasks and managing skills. The sandbox environment lets you experiment without affecting production data.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            The OpenClaw community maintains example repositories for common integration patterns including Slack bots, GitHub Actions workflows, and data pipeline integrations. These provide tested starting points for your own projects. You can find links to these resources in the developer documentation along with tutorials covering specific use cases.
          </p>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            Understanding <Link href="/how-it-works" className="underline" style={{ color: "#DC6743" }}>how OpenClaw works</Link> at a fundamental level will help you design better integrations. The architecture combines modular skills, persistent memory, and intelligent task routing — all accessible through the API.
          </p>
        </section>

        <section className="mb-12 pb-12 border-t" style={{ borderColor: "#e5e5e5" }}>
          <h2 className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mt-12 mb-4" style={{ fontFamily: "var(--font-serif)" }}>
            Related Pages
          </h2>
          <ul className="space-y-2">
            <li>
              <Link href="/docs" className="text-sm hover:underline" style={{ color: "#DC6743" }}>
                Full API Documentation
              </Link>
            </li>
            <li>
              <Link href="/blog/what-is-openclaw" className="text-sm hover:underline" style={{ color: "#DC6743" }}>
                What Is OpenClaw?
              </Link>
            </li>
            <li>
              <Link href="/blog/openclaw-skills-guide" className="text-sm hover:underline" style={{ color: "#DC6743" }}>
                OpenClaw Skills Guide
              </Link>
            </li>
            <li>
              <Link href="/how-it-works" className="text-sm hover:underline" style={{ color: "#DC6743" }}>
                How OpenClaw Works
              </Link>
            </li>
          </ul>
        </section>

        <CtaBanner />
      </article>
    </>
  );
}