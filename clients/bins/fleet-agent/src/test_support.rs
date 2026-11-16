//! A loopback HTTP server for tests: records requests and answers with scripted
//! responses (the last one repeats).
//!
//! Shared by the unit tests of every module that talks to the Server.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Lower-case header names with trimmed values.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

pub struct MockServer {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// A response the route server sends for `method` and `path`.
pub type Route = (&'static str, String, u16, Vec<u8>);

impl MockServer {
    pub fn start(responses: Vec<(u16, &'static str)>) -> Self {
        let mut served = 0;
        Self::serve(move |_| {
            let (status, body) = responses[served.min(responses.len() - 1)];
            served += 1;
            (status, body.as_bytes().to_vec())
        })
    }

    /// Answers each request from the first route with its method and path,
    /// and every other request with 404.
    pub fn routes(routes: Vec<Route>) -> Self {
        Self::serve(move |request| {
            routes
                .iter()
                .find(|(method, path, _, _)| *method == request.method && *path == request.path)
                .map_or((404, Vec::new()), |(_, _, status, body)| {
                    (*status, body.clone())
                })
        })
    }

    fn serve(mut respond: impl FnMut(&Request) -> (u16, Vec<u8>) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (requests, stop) = (requests.clone(), stop.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let Some(request) = read_request(&stream) else {
                        continue;
                    };
                    let (status, body) = respond(&request);
                    requests.lock().unwrap().push(request);
                    let mut stream = stream;
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(&body);
                }
            })
        };
        Self {
            address,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}/", self.address)
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next()?.to_owned(), parts.next()?.to_owned());
    let mut length = 0;
    let mut headers = Vec::new();
    loop {
        line.clear();
        reader.read_line(&mut line).ok()?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.to_ascii_lowercase();
            if name == "content-length" {
                length = value.trim().parse().ok()?;
            }
            headers.push((name, value.trim().to_owned()));
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}
