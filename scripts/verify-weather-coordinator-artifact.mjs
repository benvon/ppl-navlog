import { verifyCoordinatorArtifact } from './weather-coordinator-artifact.mjs';

const commitSha = (process.env.CANDIDATE_SHA ?? process.env.GITHUB_SHA ?? '').trim().toLowerCase();
const version = (process.env.RELEASE_VERSION ?? '').trim();
const artifactDirectory = process.env.RELEASE_ARTIFACT_DIR ?? '.';
const result = await verifyCoordinatorArtifact(artifactDirectory, { commitSha, version });
console.log(`Coordinator artifact verified for ${result.manifest.version} (${result.manifest.commitSha}).`);
