export type ReviewAction =
    | { operation: "discard"; paths: string[] }
    | { operation: "stash_pop"; stash_oid: string };

export type GitReview = {
    action: ReviewAction;
    paths: string[];
    summary: string;
    expected_fingerprint: string;
};

export type ConfirmGitBody = {
    action: ReviewAction;
    expected_fingerprint: string;
    confirmed: true;
};

export type Stash = { oid: string; reference: string; subject: string };

export function confirmationBody(review: GitReview): ConfirmGitBody {
    return {
        action: review.action,
        expected_fingerprint: review.expected_fingerprint,
        confirmed: true,
    };
}
