import { Component, type ReactNode } from "react";

interface Props {
	children: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false, error: null };

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 p-8">
					<div className="text-4xl">Something went wrong</div>
					<p className="text-base-content/60 text-center max-w-md">
						Lily encountered an unexpected error. You can try reloading
						the page to recover.
					</p>
					{this.state.error && (
						<pre className="text-xs text-error bg-base-200 rounded p-3 max-w-lg overflow-auto max-h-32">
							{this.state.error.message}
						</pre>
					)}
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => {
							this.setState({ hasError: false, error: null });
						}}
					>
						Try Again
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}
