import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'
import artifactClient from '@actions/artifact'
import type { Artifact, FindOptions } from '@actions/artifact'
import { Minimatch } from 'minimatch'
import { Inputs, Outputs } from './constants'

const PARALLEL_DOWNLOADS = 5

// Helper function for verbose logging
const verboseLog = (message: string, verbose: boolean): void => {
  if (verbose) {
    core.info(`[VERBOSE] ${message}`)
  } else {
    core.debug(message)
  }
}

export const chunk = <T>(arr: T[], n: number): T[][] =>
  arr.reduce((acc, cur, i) => {
    const index = Math.floor(i / n)
    acc[index] = [...(acc[index] || []), cur]
    return acc
  }, [] as T[][])

export async function run(): Promise<void> {
  const inputs = {
    name: core.getInput(Inputs.Name, { required: false }),
    path: core.getInput(Inputs.Path, { required: false }),
    token: core.getInput(Inputs.GitHubToken, { required: false }),
    repository: core.getInput(Inputs.Repository, { required: false }),
    runID: parseInt(core.getInput(Inputs.RunID, { required: false })),
    pattern: core.getInput(Inputs.Pattern, { required: false }),
    mergeMultiple: core.getBooleanInput(Inputs.MergeMultiple, {
      required: false
    }),
    artifactIds: core.getInput(Inputs.ArtifactIds, { required: false }),
    verbose: core.getBooleanInput(Inputs.Verbose, { required: false })
  }

  verboseLog(`Starting download-artifact action with inputs: ${JSON.stringify({
    name: inputs.name || '<not provided>',
    path: inputs.path || '<not provided>',
    token: inputs.token ? '<provided>' : '<not provided>',
    repository: inputs.repository || '<not provided>',
    runID: inputs.runID || '<not provided>',
    pattern: inputs.pattern || '<not provided>',
    mergeMultiple: inputs.mergeMultiple,
    artifactIds: inputs.artifactIds || '<not provided>',
    verbose: inputs.verbose
  }, null, 2)}`, inputs.verbose)

  if (!inputs.path) {
    inputs.path = process.env['GITHUB_WORKSPACE'] || process.cwd()
    verboseLog(`No path provided, using default: ${inputs.path}`, inputs.verbose)
  }

  if (inputs.path.startsWith(`~`)) {
    const originalPath = inputs.path
    inputs.path = inputs.path.replace('~', os.homedir())
    verboseLog(`Expanded tilde path from ${originalPath} to ${inputs.path}`, inputs.verbose)
  }

  // Check for mutually exclusive inputs
  if (inputs.name && inputs.artifactIds) {
    throw new Error(
      `Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.`
    )
  }

  const isSingleArtifactDownload = !!inputs.name
  const isDownloadByIds = !!inputs.artifactIds
  const resolvedPath = path.resolve(inputs.path)
  core.debug(`Resolved path is ${resolvedPath}`)
  verboseLog(`Download mode: ${isSingleArtifactDownload ? 'single artifact by name' : isDownloadByIds ? 'multiple artifacts by IDs' : 'all/filtered artifacts'}`, inputs.verbose)
  verboseLog(`Final resolved download path: ${resolvedPath}`, inputs.verbose)

  const options: FindOptions = {}
  if (inputs.token) {
    verboseLog(`GitHub token provided, setting up cross-repository download`, inputs.verbose)
    const [repositoryOwner, repositoryName] = inputs.repository.split('/')
    if (!repositoryOwner || !repositoryName) {
      throw new Error(
        `Invalid repository: '${inputs.repository}'. Must be in format owner/repo`
      )
    }

    options.findBy = {
      token: inputs.token,
      workflowRunId: inputs.runID,
      repositoryName,
      repositoryOwner
    }
    verboseLog(`Configured cross-repository download: ${repositoryOwner}/${repositoryName}, run ID: ${inputs.runID}`, inputs.verbose)
  } else {
    verboseLog(`No GitHub token provided, downloading from current repository/run`, inputs.verbose)
  }

  let artifacts: Artifact[] = []
  let artifactIds: number[] = []

  if (isSingleArtifactDownload) {
    core.info(`Downloading single artifact`)
    verboseLog(`Attempting to fetch artifact with name: '${inputs.name}'`, inputs.verbose)

    const { artifact: targetArtifact } = await artifactClient.getArtifact(
      inputs.name,
      options
    )

    if (!targetArtifact) {
      throw new Error(`Artifact '${inputs.name}' not found`)
    }

    core.debug(
      `Found named artifact '${inputs.name}' (ID: ${targetArtifact.id}, Size: ${targetArtifact.size})`
    )
    verboseLog(`Successfully retrieved artifact metadata - ID: ${targetArtifact.id}, Size: ${targetArtifact.size} bytes, Digest: ${targetArtifact.digest}`, inputs.verbose)

    artifacts = [targetArtifact]
  } else if (isDownloadByIds) {
    core.info(`Downloading artifacts by ID`)
    verboseLog(`Parsing artifact IDs from input: '${inputs.artifactIds}'`, inputs.verbose)

    const artifactIdList = inputs.artifactIds
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '')

    if (artifactIdList.length === 0) {
      throw new Error(`No valid artifact IDs provided in 'artifact-ids' input`)
    }

    core.debug(`Parsed artifact IDs: ${JSON.stringify(artifactIdList)}`)
    verboseLog(`Parsed ${artifactIdList.length} artifact IDs: [${artifactIdList.join(', ')}]`, inputs.verbose)

    // Parse the artifact IDs
    artifactIds = artifactIdList.map(id => {
      const numericId = parseInt(id, 10)
      if (isNaN(numericId)) {
        throw new Error(`Invalid artifact ID: '${id}'. Must be a number.`)
      }
      return numericId
    })

    verboseLog(`Fetching all artifacts to find matching IDs`, inputs.verbose)
    // We need to fetch all artifacts to get metadata for the specified IDs
    const listArtifactResponse = await artifactClient.listArtifacts({
      latest: true,
      ...options
    })

    verboseLog(`Retrieved ${listArtifactResponse.artifacts.length} total artifacts from API`, inputs.verbose)

    artifacts = listArtifactResponse.artifacts.filter(artifact =>
      artifactIds.includes(artifact.id)
    )

    if (artifacts.length === 0) {
      throw new Error(`None of the provided artifact IDs were found`)
    }

    if (artifacts.length < artifactIds.length) {
      const foundIds = artifacts.map(a => a.id)
      const missingIds = artifactIds.filter(id => !foundIds.includes(id))
      core.warning(
        `Could not find the following artifact IDs: ${missingIds.join(', ')}`
      )
      verboseLog(`Missing artifact IDs: [${missingIds.join(', ')}]`, inputs.verbose)
    }

    core.debug(`Found ${artifacts.length} artifacts by ID`)
    verboseLog(`Successfully matched ${artifacts.length} out of ${artifactIds.length} requested artifact IDs`, inputs.verbose)
  } else {
    verboseLog(`Listing all artifacts for filtering/download`, inputs.verbose)
    const listArtifactResponse = await artifactClient.listArtifacts({
      latest: true,
      ...options
    })
    artifacts = listArtifactResponse.artifacts

    core.debug(`Found ${artifacts.length} artifacts in run`)
    verboseLog(`Retrieved ${artifacts.length} artifacts from API`, inputs.verbose)

    if (inputs.pattern) {
      core.info(`Filtering artifacts by pattern '${inputs.pattern}'`)
      verboseLog(`Applying glob pattern filter: '${inputs.pattern}'`, inputs.verbose)
      const matcher = new Minimatch(inputs.pattern)
      const originalCount = artifacts.length
      artifacts = artifacts.filter(artifact => matcher.match(artifact.name))
      core.debug(
        `Filtered from ${listArtifactResponse.artifacts.length} to ${artifacts.length} artifacts`
      )
      verboseLog(`Pattern filter reduced artifacts from ${originalCount} to ${artifacts.length}`, inputs.verbose)
    } else {
      core.info(
        'No input name, artifact-ids or pattern filtered specified, downloading all artifacts'
      )
      verboseLog(`No filtering applied, will download all ${artifacts.length} artifacts`, inputs.verbose)
      if (!inputs.mergeMultiple) {
        core.info(
          'An extra directory with the artifact name will be created for each download'
        )
        verboseLog(`Individual directories will be created for each artifact (mergeMultiple=false)`, inputs.verbose)
      }
    }
  }

  if (artifacts.length) {
    core.info(`Preparing to download the following artifacts:`)
    artifacts.forEach(artifact => {
      core.info(
        `- ${artifact.name} (ID: ${artifact.id}, Size: ${artifact.size}, Expected Digest: ${artifact.digest})`
      )
    })
  }

  verboseLog(`Starting download of ${artifacts.length} artifact(s) to: ${resolvedPath}`, inputs.verbose)

  const downloadPromises = artifacts.map(artifact => {
    const downloadPath =
      isSingleArtifactDownload ||
        inputs.mergeMultiple ||
        artifacts.length === 1
        ? resolvedPath
        : path.join(resolvedPath, artifact.name)

    verboseLog(`Artifact '${artifact.name}' will be downloaded to: ${downloadPath}`, inputs.verbose)

    return {
      name: artifact.name,
      id: artifact.id,
      downloadPath,
      promise: artifactClient.downloadArtifact(artifact.id, {
        ...options,
        path: downloadPath,
        expectedHash: artifact.digest
      })
    }
  })

  verboseLog(`Created ${downloadPromises.length} download promises, processing in chunks of ${PARALLEL_DOWNLOADS}`, inputs.verbose)

  const chunkedPromises = chunk(downloadPromises, PARALLEL_DOWNLOADS)
  let totalDownloaded = 0

  for (let chunkIndex = 0; chunkIndex < chunkedPromises.length; chunkIndex++) {
    const currentChunk = chunkedPromises[chunkIndex]
    verboseLog(`Processing chunk ${chunkIndex + 1}/${chunkedPromises.length} with ${currentChunk.length} artifacts`, inputs.verbose)

    const chunkPromises = currentChunk.map((item, itemIndex) => {
      verboseLog(`Starting download ${totalDownloaded + itemIndex + 1}/${artifacts.length}: '${item.name}' (ID: ${item.id}) to ${item.downloadPath}`, inputs.verbose)
      return item.promise.then(result => {
        verboseLog(`Completed download: '${item.name}' (digestMismatch: ${result.digestMismatch})`, inputs.verbose)
        return result
      }).catch(error => {
        verboseLog(`Failed download: '${item.name}' - Error: ${error.message}`, inputs.verbose)
        core.error(`Download failed for artifact '${item.name}': ${error.message}`)
        throw error
      })
    })

    verboseLog(`Waiting for ${chunkPromises.length} downloads to complete...`, inputs.verbose)
    const results = await Promise.all(chunkPromises)
    verboseLog(`Chunk ${chunkIndex + 1} completed successfully`, inputs.verbose)

    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]
      const artifactName = currentChunk[i].name

      if (outcome.digestMismatch) {
        core.warning(
          `Artifact '${artifactName}' digest validation failed. Please verify the integrity of the artifact.`
        )
        verboseLog(`Digest mismatch detected for artifact '${artifactName}'`, inputs.verbose)
      } else {
        verboseLog(`Digest validation passed for artifact '${artifactName}'`, inputs.verbose)
      }
    }

    totalDownloaded += currentChunk.length
    verboseLog(`Progress: ${totalDownloaded}/${artifacts.length} artifacts downloaded`, inputs.verbose)
  }

  verboseLog(`All downloads completed successfully`, inputs.verbose)
  core.info(`Total of ${artifacts.length} artifact(s) downloaded`)
  core.setOutput(Outputs.DownloadPath, resolvedPath)
  verboseLog(`Set output 'download-path' to: ${resolvedPath}`, inputs.verbose)
  core.info('Download artifact has finished successfully')
  verboseLog(`Action completed successfully - all ${artifacts.length} artifacts downloaded`, inputs.verbose)
}

run().catch(err => {
  core.error(`Action failed with error: ${err.message}`)
  if (err.stack) {
    core.debug(`Stack trace: ${err.stack}`)
  }
  core.setFailed(`Unable to download artifact(s): ${err.message}`)
})
