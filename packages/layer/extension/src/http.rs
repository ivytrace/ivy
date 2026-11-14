//! Minimal HTTP/1.1 over `std::net` for the two plain-HTTP sides: the Extensions API client
//! and the localhost span intake. One request per connection (`Connection: close`).

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_HEAD_BYTES: usize = 64 * 1024;

pub struct Message {
    /// Request line (`POST /spans HTTP/1.1`) or status line (`HTTP/1.1 200 OK`).
    pub start: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Message {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn status(&self) -> u16 {
        self.start.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    /// Method and path of a request.
    pub fn route(&self) -> (&str, &str) {
        let mut parts = self.start.split(' ');
        (parts.next().unwrap_or(""), parts.next().unwrap_or(""))
    }
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

fn read_line<R: BufRead>(r: &mut R, budget: &mut usize) -> io::Result<String> {
    let mut line = Vec::new();
    let n = r.by_ref().take(*budget as u64 + 1).read_until(b'\n', &mut line)?;
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
    }
    if n > *budget {
        return Err(invalid("header section too large"));
    }
    *budget -= n;
    while line.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| invalid("non-UTF-8 header"))
}

fn read_chunked<R: BufRead>(r: &mut R, max_body: usize) -> io::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut budget = MAX_HEAD_BYTES;
        let line = read_line(r, &mut budget)?;
        let size_hex = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| invalid("bad chunk size"))?;
        if size == 0 {
            // Trailers until the empty line.
            while !read_line(r, &mut budget)?.is_empty() {}
            return Ok(body);
        }
        if body.len() + size > max_body {
            return Err(invalid("body too large"));
        }
        let start = body.len();
        body.resize(start + size, 0);
        r.read_exact(&mut body[start..])?;
        read_line(r, &mut budget)?;
    }
}

/// Reads one HTTP/1.1 message. Bodies use Content-Length or chunked encoding; a response
/// without either is read until the peer closes.
pub fn read_message<R: BufRead>(r: &mut R, is_response: bool, max_body: usize) -> io::Result<Message> {
    let mut budget = MAX_HEAD_BYTES;
    let start = read_line(r, &mut budget)?;
    let mut headers = Vec::new();
    loop {
        let line = read_line(r, &mut budget)?;
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let mut msg = Message { start, headers, body: Vec::new() };
    let chunked = msg.header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        msg.body = read_chunked(r, max_body)?;
    } else if let Some(len) = msg.header("content-length") {
        let len: usize = len.parse().map_err(|_| invalid("bad content-length"))?;
        if len > max_body {
            return Err(invalid("body too large"));
        }
        msg.body.resize(len, 0);
        r.read_exact(&mut msg.body)?;
    } else if is_response {
        r.take(max_body as u64).read_to_end(&mut msg.body)?;
    }
    Ok(msg)
}

/// Sends one request to `host:port` and reads the response. No timeout: `/next` long-polls.
pub fn request(addr: &str, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> io::Result<Message> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_nodelay(true).ok();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    stream.write_all(&out)?;
    read_message(&mut BufReader::new(stream), true, MAX_BODY_BYTES)
}

pub fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let content_type = if status == 200 { "application/json" } else { "text/plain" };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_a_content_length_request() {
        let raw = b"POST /spans HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello";
        let m = read_message(&mut Cursor::new(&raw[..]), false, 100).unwrap();
        assert_eq!(m.route(), ("POST", "/spans"));
        assert_eq!(m.body, b"hello");
    }

    #[test]
    fn reads_a_chunked_response() {
        let raw = b"HTTP/1.1 200 OK\r\nLambda-Extension-Identifier: abc\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n";
        let m = read_message(&mut Cursor::new(&raw[..]), true, 100).unwrap();
        assert_eq!(m.status(), 200);
        assert_eq!(m.header("lambda-extension-identifier"), Some("abc"));
        assert_eq!(m.body, b"hello");
    }

    #[test]
    fn rejects_oversized_bodies_and_truncated_input() {
        let raw = b"POST /spans HTTP/1.1\r\nContent-Length: 500\r\n\r\n";
        assert!(read_message(&mut Cursor::new(&raw[..]), false, 100).is_err());
        let raw = b"POST /spans HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc";
        assert!(read_message(&mut Cursor::new(&raw[..]), false, 100).is_err());
        assert!(read_message(&mut Cursor::new(&b""[..]), false, 100).is_err());
    }
}
