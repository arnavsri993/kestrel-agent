import { useState } from "react";

export function ResetDataSettings() {
	const [confirmation, setConfirmation] = useState("");
	const [resetError, setResetError] = useState("");

	async function reset() {
		const response = await window.kestrel.request({
			type: "reset-local-data",
			confirmation,
		});
		if (!response.ok)
			setResetError("error" in response ? response.error : "Reset failed");
	}

	return (
		<article className="setting-row danger">
			<div>
				<strong>Reset Kestrel and prepare for uninstall</strong>
				<p>Deletes this preview database and secure key, then relaunches.</p>
				<label>
					Type Kestrel to confirm
					<input
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
					/>
				</label>
				{resetError && <small role="alert">{resetError}</small>}
			</div>
			<button
				className="button danger-button"
				disabled={confirmation !== "Kestrel"}
				onClick={() => void reset()}
			>
				Reset local data
			</button>
		</article>
	);
}
