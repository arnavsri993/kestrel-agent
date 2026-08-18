import { Icon } from "../Icon";

export function SurfaceBackButton({
	onBack,
	label = "Browser",
}: {
	onBack(): void;
	label?: string;
}) {
	return (
		<button
			type="button"
			className="surface-back-button"
			aria-label={`Back to ${label}`}
			title={`Back to ${label}`}
			onClick={onBack}
		>
			<Icon name="back" />
			<span>{label}</span>
		</button>
	);
}
