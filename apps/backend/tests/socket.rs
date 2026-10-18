use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, header},
};
use discord_backend::{AppState, database, http};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{net::TcpListener, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error, Message, client::IntoClientRequest},
};
use tower::ServiceExt;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn identify(app: Router) -> TestResult<String> {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header(header::ORIGIN, "http://localhost:5173")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"display_name":"Ana"}"#))?,
        )
        .await?;
    Ok(response.headers()[header::SET_COOKIE]
        .to_str()?
        .split(';')
        .next()
        .ok_or("cookie")?
        .to_owned())
}

#[tokio::test]
async fn real_websocket_checks_origin_auth_and_recovers_from_malformed_events() -> TestResult {
    let state = AppState::new(
        database::connect("sqlite::memory:").await?,
        vec!["http://localhost:5173".parse()?],
    );
    let app = http::application(state.clone());
    let cookie = identify(app.clone()).await?;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/servers")
                .header(header::ORIGIN, "http://localhost:5173")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":"Sala"}"#))?,
        )
        .await?;
    let room: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await?)?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("ws://{}/api/ws", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let result: TestResult = async {
        for (origin, authenticated, status) in [
            ("https://hostile.example", true, 403),
            ("http://localhost:5173", false, 401),
        ] {
            let mut request = url.as_str().into_client_request()?;
            request
                .headers_mut()
                .insert(header::ORIGIN, origin.parse()?);
            if authenticated {
                request
                    .headers_mut()
                    .insert(header::COOKIE, cookie.parse()?);
            }
            match connect_async(request).await {
                Err(Error::Http(response)) => assert_eq!(response.status().as_u16(), status),
                _ => return Err("unexpected handshake result".into()),
            }
        }
        let mut request = url.as_str().into_client_request()?;
        request
            .headers_mut()
            .insert(header::ORIGIN, "http://localhost:5173".parse()?);
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse()?);
        let (mut socket, _) = connect_async(request).await?;
        let mut received = vec![];
        socket.send(Message::Text("not json".into())).await?;
        socket
            .send(Message::Text(
                json!({"v":1,"type":"join","server_id":room["id"]})
                    .to_string()
                    .into(),
            ))
            .await?;
        timeout(Duration::from_secs(5), async {
            while let Some(message) = socket.next().await {
                match message? {
                    Message::Text(text) => {
                        let event: Value = serde_json::from_str(&text)?;
                        received.push(event["type"].as_str().unwrap_or_default().to_owned());
                        if event["type"] == "joined" {
                            break;
                        }
                    }
                    Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                    _ => {}
                }
            }
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        })
        .await??;
        assert!(received.contains(&"error".to_owned()));
        assert!(received.contains(&"joined".to_owned()));
        socket.close(None).await?;
        Ok(())
    }
    .await;
    task.abort();
    result
}
