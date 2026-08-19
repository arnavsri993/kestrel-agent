"use client";

import { useState } from "react";

export type FaqItem = {
	question: string;
	answer: string;
	category?: string;
};

export const defaultFaqs: FaqItem[] = [
	{
		question: "How does Kestrel run local models without leaking prompts to the cloud?",
		answer:
			"Kestrel features native integration with local inference engines (such as Ollama and embedded GGUF runtimes on Apple Silicon). All project files, system prompts, vector embeddings, and working memory stay within your local machine's encrypted perimeter (AES-256-GCM). When you use local models, zero bytes of context or telemetry leave your device.",
		category: "Privacy & Architecture",
	},
	{
		question: "What are the hardware and system requirements for running Kestrel?",
		answer:
			"Kestrel is built specifically for Apple Silicon (M1, M2, M3, M4 series chips) running macOS Ventura (13.0) or later. We recommend at least 16GB of unified memory for smooth local model execution (e.g., 8B parameter models quantized to 4-bit) alongside development tools and local IDE workspaces.",
		category: "System Requirements",
	},
	{
		question: "How does Kestrel's safety & approval boundary prevent unintended actions?",
		answer:
			"Every task operates under a deterministic 5-level risk policy (Levels 0 through 4). Read-only actions and local preparations run autonomously, but any external communication, credential usage, file deletion, or sensitive state modification pauses execution and displays a high-contrast approval prompt. Consequential actions require explicit human sign-off before execution.",
		category: "Safety & Control",
	},
	{
		question: "How is Kestrel different from Cursor, Claude Code, or Copilot Workspace?",
		answer:
			"Unlike cloud-hosted coding assistants that require uploading repositories and indexing workspaces on remote servers, Kestrel is local-first by architecture. It acts as an autonomous workbench across coding, research, scheduling, and file automation with observable pause boundaries, sandboxed IPC, and explicit provenance verification.",
		category: "Product Comparison",
	},
	{
		question: "Can I use Kestrel with cloud frontier models like Claude 3.7 or GPT-4o?",
		answer:
			"Yes. Kestrel supports Bring-Your-Own-Key (BYOK) for major frontier providers (Anthropic, OpenAI, Google Gemini, OpenRouter). API keys are stored in the macOS Keychain and never enter renderer memory. Data is only transmitted to the specific provider you select, scoped strictly to the current conversation.",
		category: "Model Integrations",
	},
	{
		question: "How do I backup or completely wipe my Kestrel data?",
		answer:
			"Kestrel includes a one-click verified local backup utility that exports your encrypted state, configured skills, and history. If you wish to delete your data, the built-in destructive reset completely removes the local SQLite databases, vector indices, and Keychain entries with zero residual cloud trace.",
		category: "Data Management",
	},
];

export function FaqSection({ faqs = defaultFaqs }: { faqs?: FaqItem[] }) {
	const [openIndex, setOpenIndex] = useState<number | null>(0);

	const faqSchema = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: faq.answer,
			},
		})),
	};

	const toggleFaq = (index: number) => {
		setOpenIndex((current) => (current === index ? null : index));
	};

	return (
		<section className="faq-section" id="faq" aria-labelledby="faq-title">
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
			/>
			<div className="section-index">07 / FREQUENTLY ASKED QUESTIONS</div>
			<div className="section-heading">
				<h2 id="faq-title">
					Questions &amp; Answers.
					<span>Everything about privacy, models, and control.</span>
				</h2>
				<p>
					Clear architectural answers to common questions about Kestrel&apos;s local runtime, approval grammar, and developer setup.
				</p>
			</div>

			<div className="faq-list">
				{faqs.map((faq, index) => {
					const isOpen = openIndex === index;
					return (
						<article
							key={faq.question}
							className={`faq-item ${isOpen ? "open" : ""}`}
						>
							<button
								type="button"
								className="faq-trigger"
								onClick={() => toggleFaq(index)}
								aria-expanded={isOpen}
								aria-controls={`faq-answer-${index}`}
								id={`faq-question-${index}`}
							>
								<div className="faq-meta">
									<span className="faq-number">
										{String(index + 1).padStart(2, "0")}
									</span>
									{faq.category && (
										<span className="faq-category">{faq.category}</span>
									)}
								</div>
								<h3 className="faq-question-text">{faq.question}</h3>
								<span className="faq-icon" aria-hidden="true">
									{isOpen ? "−" : "+"}
								</span>
							</button>
							<div
								id={`faq-answer-${index}`}
								role="region"
								aria-labelledby={`faq-question-${index}`}
								className="faq-answer"
								hidden={!isOpen}
							>
								<p>{faq.answer}</p>
							</div>
						</article>
					);
				})}
			</div>
		</section>
	);
}
