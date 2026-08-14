import { useId } from "react";

export function BrandMark({
	className = "brand-mark",
	label,
}: {
	className?: string;
	label?: string;
}) {
	const checkpointId = `workstrand-checkpoint-${useId().replaceAll(":", "")}`;

	return (
		<svg
			className={className}
			viewBox="0 0 64 64"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			<defs>
				<mask id={checkpointId}>
					<rect width="64" height="64" fill="white" />
					<circle cx="43" cy="34" r="5.25" fill="black" />
				</mask>
			</defs>
			<path
				d="M14 14h36v16L20 49h31"
				fill="none"
				stroke="currentColor"
				strokeWidth="9"
				strokeLinecap="butt"
				strokeLinejoin="round"
				mask={`url(#${checkpointId})`}
			/>
			<circle className="brand-checkpoint" cx="43" cy="34" r="2.25" />
		</svg>
	);
}
