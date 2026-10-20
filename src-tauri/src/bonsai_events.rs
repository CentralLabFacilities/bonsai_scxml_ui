const MAX_EVENT_BYTES: usize = 1024 * 1024;

/// Incremental SSE framing only; Bonsai's JSON protocol stays in the renderer.
pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    has_data: bool,
    message_event: bool,
    first_line: bool,
    skip_lf: bool,
}

impl Default for SseDecoder {
    fn default() -> Self {
        Self {
            line: Vec::new(),
            data: Vec::new(),
            has_data: false,
            message_event: true,
            first_line: true,
            skip_lf: false,
        }
    }
}

impl SseDecoder {
    pub(crate) fn push(&mut self, byte: u8) -> Result<Option<String>, String> {
        if self.skip_lf {
            self.skip_lf = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        if byte == b'\r' || byte == b'\n' {
            self.skip_lf = byte == b'\r';
            return self.finish_line();
        }
        if self.line.len() + self.data.len() >= MAX_EVENT_BYTES {
            return Err("Bonsai event exceeds the 1 MiB SSE frame limit".to_string());
        }
        self.line.push(byte);
        Ok(None)
    }

    fn finish_line(&mut self) -> Result<Option<String>, String> {
        let line = std::mem::take(&mut self.line);
        let line = if self.first_line {
            self.first_line = false;
            line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&line)
        } else {
            &line
        };
        if line.is_empty() {
            let dispatch = self.has_data && self.message_event;
            self.has_data = false;
            self.message_event = true;
            let mut data = std::mem::take(&mut self.data);
            if dispatch {
                data.pop(); // Each data field contributes one trailing newline.
                return String::from_utf8(data)
                    .map(Some)
                    .map_err(|_| "Bonsai event contains invalid UTF-8".to_string());
            }
            return Ok(None);
        }

        let (field, value) = match line.iter().position(|byte| *byte == b':') {
            Some(index) => {
                let value = &line[index + 1..];
                (&line[..index], value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (line, &b""[..]),
        };
        match field {
            b"data" => {
                if self.data.len() + value.len() + 1 > MAX_EVENT_BYTES {
                    return Err("Bonsai event exceeds the 1 MiB SSE frame limit".to_string());
                }
                self.has_data = true;
                self.data.extend_from_slice(value);
                self.data.push(b'\n');
            }
            b"event" => self.message_event = value.is_empty() || value == b"message",
            _ => {}
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&[u8]]) -> Result<Vec<String>, String> {
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        for chunk in chunks {
            for byte in *chunk {
                if let Some(data) = decoder.push(*byte)? {
                    events.push(data);
                }
            }
        }
        Ok(events)
    }

    #[test]
    fn forwards_opaque_multiline_data_and_empty_data() {
        assert_eq!(
            decode(&[b": keepalive\ndata: {\ndata:  \"type\":\"snapshot\"}\n\ndata:\n\n"]).unwrap(),
            vec!["{\n \"type\":\"snapshot\"}", ""]
        );
    }

    #[test]
    fn handles_chunk_boundaries_bom_utf8_and_all_sse_line_endings() {
        let input = b"\xef\xbb\xbfdata: \xc3\xa4\r\n\r\ndata: two\r\rdata: three\n\n";
        let chunks: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(decode(&chunks).unwrap(), vec!["\u{e4}", "two", "three"]);
    }

    #[test]
    fn ignores_comments_metadata_named_events_and_incomplete_frames() {
        assert_eq!(
            decode(&[
                b": ping\n\nid: 1\nretry: 3000\n\nevent: custom\ndata: ignore\n\n\
                event: message\ndata: keep\n\ndata: incomplete\n"
            ])
            .unwrap(),
            vec!["keep"]
        );
    }

    #[test]
    fn rejects_oversized_lines_and_multiline_events() {
        let mut decoder = SseDecoder::default();
        for _ in 0..MAX_EVENT_BYTES {
            assert!(decoder.push(b'x').unwrap().is_none());
        }
        assert!(decoder.push(b'x').unwrap_err().contains("frame limit"));

        let mut decoder = SseDecoder::default();
        let line = format!("data: {}\n", "x".repeat(MAX_EVENT_BYTES / 2));
        for byte in line.bytes() {
            decoder.push(byte).unwrap();
        }
        assert!(line
            .bytes()
            .try_for_each(|byte| decoder.push(byte).map(|_| ()))
            .is_err());
    }

    #[test]
    fn rejects_invalid_utf8_in_dispatched_data() {
        assert!(decode(&[b"data: \xff\n\n"]).unwrap_err().contains("UTF-8"));
    }
}
