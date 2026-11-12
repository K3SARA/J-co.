# Railway Review Persistence Setup

## Why reviews disappear

Reviews are saved to a JSON file. If that file is inside the app container filesystem, it can reset on redeploy/restart.

## Exact fix

1. In Railway project, open your service.
2. Go to `Volumes` and create a volume.
3. Mount it at `/data`.
4. Go to `Variables` and add:
   - `REVIEWS_DB_FILE=/data/reviews.db.json`
5. Redeploy the service.

## Verify

1. Submit a test review.
2. Restart or redeploy the service.
3. Refresh site and confirm the review still appears.
