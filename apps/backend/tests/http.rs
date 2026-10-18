use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use discord_backend::{AppState, database, http};
use tower::ServiceExt;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn health_returns_documented_json() -> TestResult {
    let app = http::application(AppState::new(
        database::connect("sqlite::memory:").await?,
        vec!["http://localhost:5173".parse()?],
    ));
    let response = app
        .oneshot(Request::builder().uri("/health").body(Body::empty())?)
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let body = to_bytes(response.into_body(), 1024).await?;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body)?,
        serde_json::json!({"status": "ok"})
    );
    Ok(())
}

#[tokio::test]
async fn cors_only_grants_access_to_configured_origins() -> TestResult {
    for (origin, allowed) in [
        ("http://localhost:5173", true),
        ("http://127.0.0.1:5173", true),
        ("https://untrusted.example", false),
    ] {
        let app = http::application(AppState::new(
            database::connect("sqlite::memory:").await?,
            vec![
                "http://localhost:5173".parse()?,
                "http://127.0.0.1:5173".parse()?,
            ],
        ));
        let request = Request::builder()
            .method("OPTIONS")
            .uri("/health")
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .body(Body::empty())?;
        let response = app.oneshot(request).await?;
        assert!(response.status().is_success());
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_some(),
            allowed
        );
        if allowed {
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                origin
            );
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
                "GET,POST"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn unknown_routes_return_not_found() -> TestResult {
    let response = http::application(AppState::new(
        database::connect("sqlite::memory:").await?,
        vec![],
    ))
    .oneshot(Request::builder().uri("/servers").body(Body::empty())?)
    .await?;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    Ok(())
}
