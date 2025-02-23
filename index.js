const express = require("express");
const AWS = require("aws-sdk");
const crypto = require("crypto");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(cors("*"));
app.use(express.json());

AWS.config.update({
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();
const mediaConvert = new AWS.MediaConvert({
	endpoint: process.env.AWS_MEDIACONVERT_ENDPOINT,
});

const bucketName = process.env.AWS_BUCKET_NAME;
const videoUploadPrefix = "short-videos/";
const hlsOutputPrefix = "short-videos-hls/";

app.get("/", (req, res) => {
	try {
		res.status(200).send("Meydan S3 Up and Running!");
	} catch (error) {
		console.log(error);
	}
});

app.post("/generate-signed-url", (req, res) => {
	try {
		const { filename, contentType } = req.body;

		if (!filename || !contentType) {
			return res.status(400).json({ error: "Filename and Content-Type are required." });
		}

		const key = `${videoUploadPrefix}${crypto.randomBytes(16).toString("hex")}-${filename}`;

		const params = {
			Bucket: bucketName,
			Key: key,
			Expires: 60 * 5,
			ContentType: contentType,
		};

		s3.getSignedUrl("putObject", params, (err, url) => {
			if (err) {
				console.error("Error generating signed URL:", err);
				return res.status(500).json({ error: "Failed to generate signed URL." });
			}

			res.json({ signedUrl: url, key: key });
		});
	} catch (error) {
		console.error("Error:", error);
		res.status(500).json({ error: "An internal server error occurred." });
	}
});

app.post("/generate-download-url", (req, res) => {
	try {
		const { key } = req.body;

		if (!key) {
			return res.status(400).json({ error: "Key is required." });
		}

		const params = {
			Bucket: bucketName,
			Key: key,
			Expires: 60 * 5, // URL expires in 5 minutes
		};

		s3.getSignedUrl("getObject", params, (err, url) => {
			if (err) {
				console.error("Error generating signed download URL:", err);
				return res.status(500).json({ error: "Failed to generate signed download URL." });
			}

			res.json({ signedUrl: url });
		});
	} catch (error) {
		console.error("Error:", error);
		res.status(500).json({ error: "An internal server error occurred." });
	}
});

app.post("/trigger-hls-conversion", async (req, res) => {
	try {
		const { key } = req.body;

		if (!key) {
			return res.status(400).json({ error: "Key is required." });
		}

		const params = {
			Queue: process.env.AWS_MEDIACONVERT_QUEUE,
			UserMetadata: {},
			Role: process.env.AWS_MEDIACONVERT_ROLE,
			Settings: {
				TimecodeConfig: {
					Source: "ZEROBASED",
				},
				OutputGroups: [
					{
						CustomName: "awselementalmediaconvertjob",
						Name: "Apple HLS",
						Outputs: [
							{
								ContainerSettings: {
									Container: "M3U8",
									M3u8Settings: {},
								},
								VideoDescription: {
									CodecSettings: {
										Codec: "H_264",
										H264Settings: {
											MaxBitrate: 5000000,
											RateControlMode: "QVBR",
											SceneChangeDetect: "TRANSITION_DETECTION",
										},
									},
								},
								AudioDescriptions: [
									{
										CodecSettings: {
											Codec: "AAC",
											AacSettings: {
												Bitrate: 96000,
												CodingMode: "CODING_MODE_2_0",
												SampleRate: 48000,
											},
										},
									},
								],
								OutputSettings: {
									HlsSettings: {
										SegmentModifier: "hlsconveriton2",
									},
								},
								NameModifier: "hlsconvertion",
							},
						],
						OutputGroupSettings: {
							Type: "HLS_GROUP_SETTINGS",
							HlsGroupSettings: {
								SegmentLength: 10,
								Destination: `s3://${bucketName}/${hlsOutputPrefix}`,
								DestinationSettings: {
									S3Settings: {
										StorageClass: "STANDARD",
									},
								},
								MinSegmentLength: 0,
							},
						},
					},
				],
				FollowSource: 1,
				Inputs: [
					{
						AudioSelectors: {
							"Audio Selector 1": {
								DefaultSelection: "DEFAULT",
							},
						},
						VideoSelector: {},
						TimecodeSource: "ZEROBASED",
						FileInput: `s3://${bucketName}/${key}`,
					},
				],
			},
			BillingTagsSource: "JOB",
			AccelerationSettings: {
				Mode: "DISABLED",
			},
			StatusUpdateInterval: "SECONDS_60",
			Priority: 0,
		};

		const data = await mediaConvert.createJob(params).promise();
		res.status(200).json({ message: "MediaConvert job triggered", jobId: data.Job.Id });
	} catch (error) {
		console.error("Error triggering MediaConvert job:", error);
		res.status(500).json({ error: "Failed to trigger MediaConvert job." });
	}
});

app.post("/job-status", async (req, res) => {
	try {
		const jobId = req.body.jobId;

		if (!jobId) {
			return res.status(400).json({ error: "Job ID is required." });
		}

		const params = {
			Id: jobId,
		};

		const data = await mediaConvert.getJob(params).promise();

		if (data && data.Job) {
			res.status(200).json({
				jobId: data.Job.Id,
				status: data.Job.Status,
				messages: data.Job.Messages,
				timing: data.Job.Timing,
				arn: data.Job.Arn,
				createdAt: data.Job.CreatedAt,
			});
		} else {
			res.status(404).json({ error: "Job not found." });
		}
	} catch (error) {
		console.error("Error getting job status:", error);
		res.status(500).json({ error: "Failed to get job status." });
	}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});
